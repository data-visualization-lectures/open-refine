import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { projectBelongsTo } from "@/lib/project-registry";
import { buildBackendHeaders, ensureCsrfHeader, parseMaxUploadSizeMb } from "@/lib/proxy";
import {
  createOpenRefineSavedProject,
  deleteOpenRefineStorageObject,
  listOpenRefineSavedProjects,
  uploadOpenRefineArchive,
  uploadOpenRefineThumbnailFromDataUri
} from "@/lib/openrefine-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SaveOpenRefineProjectRequest = {
  name?: string;
  openrefineProjectId?: string;
  thumbnail?: string;
  sourceFilename?: string;
  openrefineVersion?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

function normalizeProjectName(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new ApiError(400, "name is required");
  }
  if (value.length > 200) {
    throw new ApiError(400, "name must be 200 characters or fewer");
  }
  return value;
}

function normalizeOpenRefineProjectId(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new ApiError(400, "openrefineProjectId is required");
  }
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "openrefineProjectId must be numeric");
  }
  return value;
}

function sanitizeFileComponent(value: string): string {
  const compact = value.trim().replace(/\s+/g, "-");
  const sanitized = compact.replace(/[^A-Za-z0-9._-]/g, "");
  return sanitized || "project";
}

async function exportOpenRefineArchive(request: Request, openrefineProjectId: string, fileStem: string): Promise<ArrayBuffer> {
  const backendBase = requiredEnv("OPENREFINE_BACKEND_URL");
  const encodedName = encodeURIComponent(`${sanitizeFileComponent(fileStem)}.openrefine.tar.gz`);
  const exportUrl = new URL(`/command/core/export-project/${encodedName}`, backendBase);

  const headers = buildBackendHeaders(request);
  headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  await ensureCsrfHeader(request, headers, "POST");

  const payload = new URLSearchParams();
  payload.set("project", openrefineProjectId);

  let upstream = await fetch(exportUrl, {
    method: "POST",
    headers,
    body: payload.toString(),
    redirect: "manual",
    cache: "no-store"
  });

  const isRedirect = upstream.status >= 300 && upstream.status < 400;
  const redirectLocation = upstream.headers.get("location");
  if (isRedirect && redirectLocation) {
    const downloadUrl = new URL(redirectLocation, backendBase);
    const downloadHeaders = new Headers(headers);
    downloadHeaders.delete("content-type");
    upstream = await fetch(downloadUrl, {
      method: "GET",
      headers: downloadHeaders,
      cache: "no-store"
    });
  }

  if (!upstream.ok) {
    const reason = await upstream.text();
    throw new ApiError(upstream.status, `OpenRefine export-project failed: ${reason}`);
  }

  const archive = await upstream.arrayBuffer();
  if (!archive.byteLength) {
    throw new ApiError(502, "OpenRefine export-project returned empty archive");
  }
  return archive;
}

async function parseRequestBody(request: Request): Promise<SaveOpenRefineProjectRequest> {
  try {
    const parsed = (await request.json()) as SaveOpenRefineProjectRequest;
    return parsed ?? {};
  } catch {
    throw new ApiError(400, "Request body must be JSON");
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const projects = await listOpenRefineSavedProjects(user.accessToken, user.id);
    return Response.json({ projects });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const body = await parseRequestBody(request);
    const name = normalizeProjectName(body.name);
    const openrefineProjectId = normalizeOpenRefineProjectId(body.openrefineProjectId);

    if (!(await projectBelongsTo(openrefineProjectId, user.id, user.accessToken))) {
      throw new ApiError(403, "OpenRefine project does not belong to the authenticated user");
    }

    const archive = await exportOpenRefineArchive(request, openrefineProjectId, name);
    const maxBytes = parseMaxUploadSizeMb() * 1024 * 1024;
    if (archive.byteLength > maxBytes) {
      throw new ApiError(413, "Exported archive exceeds MAX_UPLOAD_SIZE_MB");
    }

    const savedProjectId = crypto.randomUUID();
    const archivePath = `${user.id}/${savedProjectId}/project.tar.gz`;
    const thumbnailPath = body.thumbnail ? `${user.id}/${savedProjectId}/thumbnail.png` : null;

    await uploadOpenRefineArchive(user.accessToken, archivePath, archive);
    try {
      if (body.thumbnail) {
        await uploadOpenRefineThumbnailFromDataUri(user.accessToken, thumbnailPath!, body.thumbnail);
      }

      const project = await createOpenRefineSavedProject(user.accessToken, {
        id: savedProjectId,
        user_id: user.id,
        name,
        archive_path: archivePath,
        thumbnail_path: thumbnailPath,
        openrefine_version: body.openrefineVersion?.trim() || null,
        source_filename: body.sourceFilename?.trim() || null,
        size_bytes: archive.byteLength
      });

      return Response.json({ project }, { status: 201 });
    } catch (error) {
      await deleteOpenRefineStorageObject(user.accessToken, archivePath).catch(() => undefined);
      if (thumbnailPath) {
        await deleteOpenRefineStorageObject(user.accessToken, thumbnailPath).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
