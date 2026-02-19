import { ApiError } from "@/lib/api-error";
import { type AuthenticatedUser, requireAuthenticatedUser } from "@/lib/auth";
import { createProjectName } from "@/lib/project-id";
import { registerProject } from "@/lib/project-registry";
import {
  buildBackendHeaders,
  ensureCsrfHeader,
  parseMaxUploadSizeMb,
  relayBackendResponse
} from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseProjectId(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/project=(\d+)/);
  return match?.[1] ?? null;
}

function parseProjectIdFromJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates = [parsed.project, parsed.projectID, parsed.projectId];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
      if (typeof candidate === "string") {
        const direct = candidate.match(/^\d+$/)?.[0];
        if (direct) {
          return direct;
        }
        const nested = parseProjectId(candidate);
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // Not JSON; caller will try other parsers.
  }
  return null;
}

function parseProjectIdFromBody(raw: string): string | null {
  const fromQuery = parseProjectId(raw);
  if (fromQuery) {
    return fromQuery;
  }

  const fromJson = parseProjectIdFromJson(raw);
  if (fromJson) {
    return fromJson;
  }

  const fromPath = raw.match(/\/project\?project=(\d+)/)?.[1];
  if (fromPath) {
    return fromPath;
  }

  const fromProjectKey = raw.match(/"project(?:ID|Id)?"\s*:\s*"?(?<id>\d+)"?/)?.groups?.id;
  if (fromProjectKey) {
    return fromProjectKey;
  }

  return null;
}

type AllMetadataResponse = {
  projects?: Record<
    string,
    {
      name?: string;
    }
  >;
};

async function findProjectIdByName(
  backendBase: string,
  baseHeaders: Headers,
  projectName: string
): Promise<string | null> {
  const metadataUrl = new URL("/command/core/get-all-project-metadata", backendBase);
  const headers = new Headers(baseHeaders);
  headers.delete("content-type");

  const metadataResponse = await fetch(metadataUrl, {
    method: "GET",
    headers,
    cache: "no-store"
  });
  if (!metadataResponse.ok) {
    return null;
  }

  const body = (await metadataResponse.json()) as AllMetadataResponse;
  const projects = body.projects ?? {};
  for (const [projectId, metadata] of Object.entries(projects)) {
    if (metadata?.name === projectName) {
      return projectId;
    }
  }

  return null;
}

function allowAnonymousProjectCreate(): boolean {
  return process.env.ALLOW_ANON_PROJECT_CREATE === "true";
}

function resolveAnonymousUser(): AuthenticatedUser {
  return {
    id: process.env.DEV_FALLBACK_USER_ID ?? "local-dev-user",
    accessToken: ""
  };
}

async function resolveUploadUser(request: Request): Promise<{ user: AuthenticatedUser; authMode: "supabase" | "anonymous" }> {
  try {
    const user = await requireAuthenticatedUser(request);
    return { user, authMode: "supabase" };
  } catch (error) {
    if (allowAnonymousProjectCreate() && error instanceof ApiError && error.status === 401) {
      return { user: resolveAnonymousUser(), authMode: "anonymous" };
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user, authMode } = await resolveUploadUser(request);
    const maxUploadBytes = parseMaxUploadSizeMb() * 1024 * 1024;
    const contentLengthRaw = request.headers.get("content-length");
    const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : 0;
    if (contentLength > maxUploadBytes) {
      throw new ApiError(413, "Uploaded file exceeds MAX_UPLOAD_SIZE_MB");
    }

    const projectName = createProjectName(user.id);
    const backendBase = process.env.OPENREFINE_BACKEND_URL;
    if (!backendBase) {
      throw new ApiError(500, "Missing environment variable: OPENREFINE_BACKEND_URL");
    }
    const backendUrl = new URL("/command/core/create-project-from-upload", backendBase);
    backendUrl.searchParams.set("projectName", projectName);

    const body = await request.arrayBuffer();
    if (body.byteLength > maxUploadBytes) {
      throw new ApiError(413, "Uploaded file exceeds MAX_UPLOAD_SIZE_MB");
    }
    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, "POST");
    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      cache: "no-store"
    });

    const location = backendResponse.headers.get("location");
    const projectIdFromLocation = parseProjectId(location);
    const projectIdFromFinalUrl = parseProjectId(backendResponse.url);
    const projectId = projectIdFromLocation ?? projectIdFromFinalUrl;
    if (!backendResponse.ok && backendResponse.status !== 302) {
      return relayBackendResponse(backendResponse);
    }
    if (!projectId) {
      const fallbackFromMetadata = await findProjectIdByName(backendBase, headers, projectName);
      if (fallbackFromMetadata) {
        registerProject(fallbackFromMetadata, user.id, projectName);

        const responseHeaders = new Headers();
        const setCookie = backendResponse.headers.get("set-cookie");
        if (setCookie) {
          responseHeaders.append("set-cookie", setCookie);
        }

        return Response.json(
          { projectId: fallbackFromMetadata, projectName, authMode, idSource: "metadata" },
          {
            status: 201,
            headers: responseHeaders
          }
        );
      }

      const fallbackBody = await backendResponse.text();
      const fallbackProjectId = parseProjectIdFromBody(fallbackBody);
      if (fallbackProjectId) {
        registerProject(fallbackProjectId, user.id, projectName);

        const responseHeaders = new Headers();
        const setCookie = backendResponse.headers.get("set-cookie");
        if (setCookie) {
          responseHeaders.append("set-cookie", setCookie);
        }

        return Response.json(
          { projectId: fallbackProjectId, projectName, authMode, idSource: "body" },
          {
            status: 201,
            headers: responseHeaders
          }
        );
      }
      throw new ApiError(
        502,
        `Could not parse project id (status=${backendResponse.status}, location=${location ?? "none"}, finalUrl=${backendResponse.url})`
      );
    }

    registerProject(projectId, user.id, projectName);

    const responseHeaders = new Headers();
    const setCookie = backendResponse.headers.get("set-cookie");
    if (setCookie) {
      responseHeaders.append("set-cookie", setCookie);
    }

    return Response.json(
      { projectId, projectName, authMode, idSource: "redirect" },
      {
        status: 201,
        headers: responseHeaders
      }
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
