import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { createProjectName } from "@/lib/project-id";
import { registerProject } from "@/lib/project-registry";
import { buildBackendHeaders, ensureCsrfHeader } from "@/lib/proxy";
import { downloadOpenRefineArchive, getOpenRefineSavedProject } from "@/lib/openrefine-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: { id: string };
};

type RestoreRequestBody = {
  projectName?: string;
};

type AllMetadataResponse = {
  projects?: Record<
    string,
    {
      name?: string;
    }
  >;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

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
    // Not JSON.
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

async function parseRequestBody(request: Request): Promise<RestoreRequestBody> {
  try {
    const body = (await request.json()) as RestoreRequestBody;
    return body ?? {};
  } catch {
    return {};
  }
}

function normalizeRestoreProjectName(userId: string, explicitName?: string): string {
  const trimmed = explicitName?.trim();
  if (trimmed) {
    return trimmed;
  }
  return createProjectName(userId);
}

async function findProjectIdByName(backendBase: string, headers: Headers, projectName: string): Promise<string | null> {
  const metadataUrl = new URL("/command/core/get-all-project-metadata", backendBase);
  const metadataHeaders = new Headers(headers);
  metadataHeaders.delete("content-type");

  const response = await fetch(metadataUrl, {
    method: "GET",
    headers: metadataHeaders,
    cache: "no-store"
  });
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as AllMetadataResponse;
  for (const [projectId, meta] of Object.entries(body.projects ?? {})) {
    if (meta?.name === projectName) {
      return projectId;
    }
  }
  return null;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const savedProjectId = context.params.id.trim();
    if (!savedProjectId) {
      throw new ApiError(400, "Saved project id is required");
    }

    const saved = await getOpenRefineSavedProject(user.accessToken, user.id, savedProjectId);
    if (!saved) {
      throw new ApiError(404, "Saved project not found");
    }

    const requestBody = await parseRequestBody(request);
    const restoreProjectName = normalizeRestoreProjectName(user.id, requestBody.projectName);
    const archive = await downloadOpenRefineArchive(user.accessToken, saved.archivePath);

    const backendBase = requiredEnv("OPENREFINE_BACKEND_URL");
    const backendUrl = new URL("/command/core/import-project", backendBase);
    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, "POST");

    const csrfToken = headers.get("x-token");
    if (csrfToken) {
      backendUrl.searchParams.set("csrf_token", csrfToken);
    }
    headers.delete("content-type");

    const form = new FormData();
    form.append(
      "project-file",
      new Blob([archive], { type: "application/gzip" }),
      `${restoreProjectName}.openrefine.tar.gz`
    );
    form.append("project-name", restoreProjectName);

    const upstream = await fetch(backendUrl, {
      method: "POST",
      headers,
      body: form,
      redirect: "manual",
      cache: "no-store"
    });

    const location = upstream.headers.get("location");
    const projectIdFromLocation = parseProjectId(location);
    const projectIdFromFinalUrl = parseProjectId(upstream.url);
    if (!upstream.ok && upstream.status !== 302) {
      const text = await upstream.text();
      throw new ApiError(upstream.status, `OpenRefine import-project failed: ${text}`);
    }

    let projectId = projectIdFromLocation ?? projectIdFromFinalUrl;
    let idSource: "redirect" | "metadata" | "body" = "redirect";

    if (!projectId) {
      const metadataProjectId = await findProjectIdByName(backendBase, headers, restoreProjectName);
      if (metadataProjectId) {
        projectId = metadataProjectId;
        idSource = "metadata";
      }
    }

    if (!projectId) {
      const text = await upstream.text();
      const fromBody = parseProjectIdFromBody(text);
      if (fromBody) {
        projectId = fromBody;
        idSource = "body";
      }
    }

    if (!projectId) {
      throw new ApiError(
        502,
        `Could not parse restored project id (status=${upstream.status}, location=${location ?? "none"}, finalUrl=${upstream.url})`
      );
    }

    await registerProject(projectId, user.id, restoreProjectName, user.accessToken);
    return Response.json(
      {
        projectId,
        projectName: restoreProjectName,
        restoredFromSavedProjectId: savedProjectId,
        idSource
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

