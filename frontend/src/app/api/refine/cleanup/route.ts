import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { buildBackendHeaders, ensureCsrfHeader } from "@/lib/proxy";
import { projectBelongsTo, removeProject } from "@/lib/project-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseProjectId(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { projectId?: string };
    return body.projectId ?? null;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await request.text();
    const data = new URLSearchParams(raw);
    return data.get("projectId");
  }

  const raw = await request.text();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { projectId?: string };
    return parsed.projectId ?? null;
  } catch {
    return raw.trim() || null;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const projectId = await parseProjectId(request);
    if (!projectId) {
      throw new ApiError(400, "projectId is required");
    }
    if (!projectBelongsTo(projectId, user.id)) {
      throw new ApiError(403, "Project does not belong to the authenticated user");
    }

    const backendBase = process.env.OPENREFINE_BACKEND_URL;
    if (!backendBase) {
      throw new ApiError(500, "Missing environment variable: OPENREFINE_BACKEND_URL");
    }
    const backendUrl = new URL("/command/core/delete-project", backendBase);
    backendUrl.searchParams.set("project", projectId);
    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, "POST");

    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers,
      cache: "no-store"
    });

    if (!backendResponse.ok) {
      const text = await backendResponse.text();
      throw new ApiError(backendResponse.status, `OpenRefine delete failed: ${text}`);
    }

    removeProject(projectId);
    return Response.json({ deleted: true, projectId });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
