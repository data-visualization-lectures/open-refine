import { ApiError } from "@/lib/api-error";

const DEFAULT_BUCKET = "openrefine-projects";
const OPENREFINE_PROJECT_SELECT =
  "id,name,archive_path,thumbnail_path,openrefine_version,source_filename,size_bytes,created_at,updated_at";

type OpenRefineProjectRow = {
  id: string;
  name: string;
  archive_path: string;
  thumbnail_path: string | null;
  openrefine_version: string | null;
  source_filename: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
};

export type OpenRefineSavedProject = {
  id: string;
  name: string;
  archivePath: string;
  thumbnailPath: string | null;
  openrefineVersion: string | null;
  sourceFilename: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
};

type OpenRefineProjectInsert = {
  id: string;
  user_id: string;
  name: string;
  archive_path: string;
  thumbnail_path?: string | null;
  openrefine_version?: string | null;
  source_filename?: string | null;
  size_bytes?: number | null;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

function supabaseUrl(): string {
  return requiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
}

function supabaseAnonKey(): string {
  return requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

function openRefineProjectBucket(): string {
  return process.env.OPENREFINE_PROJECT_BUCKET?.trim() || DEFAULT_BUCKET;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function mapProjectRow(row: OpenRefineProjectRow): OpenRefineSavedProject {
  return {
    id: row.id,
    name: row.name,
    archivePath: row.archive_path,
    thumbnailPath: row.thumbnail_path,
    openrefineVersion: row.openrefine_version,
    sourceFilename: row.source_filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function parseSupabaseError(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: string;
      message?: string;
      error_description?: string;
      details?: string;
      hint?: string;
    };
    const candidate =
      parsed.message ??
      parsed.error_description ??
      parsed.error ??
      parsed.details ??
      parsed.hint ??
      text;
    return `${fallbackMessage}: ${candidate}`;
  } catch {
    return `${fallbackMessage}: ${text}`;
  }
}

function buildSupabaseHeaders(accessToken: string, contentType?: string): Headers {
  const headers = new Headers();
  headers.set("apikey", supabaseAnonKey());
  headers.set("authorization", `Bearer ${accessToken}`);
  if (contentType) {
    headers.set("content-type", contentType);
  }
  return headers;
}

export async function listOpenRefineSavedProjects(accessToken: string, userId: string): Promise<OpenRefineSavedProject[]> {
  const params = new URLSearchParams();
  params.set("select", OPENREFINE_PROJECT_SELECT);
  params.set("user_id", `eq.${userId}`);
  params.set("order", "updated_at.desc");

  const response = await fetch(`${supabaseUrl()}/rest/v1/openrefine_projects?${params.toString()}`, {
    method: "GET",
    headers: buildSupabaseHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to list openrefine_projects");
    throw new ApiError(response.status, detail);
  }

  const rows = (await response.json()) as OpenRefineProjectRow[];
  return rows.map(mapProjectRow);
}

export async function getOpenRefineSavedProject(
  accessToken: string,
  userId: string,
  projectId: string
): Promise<OpenRefineSavedProject | null> {
  const params = new URLSearchParams();
  params.set("select", OPENREFINE_PROJECT_SELECT);
  params.set("id", `eq.${projectId}`);
  params.set("user_id", `eq.${userId}`);
  params.set("limit", "1");

  const response = await fetch(`${supabaseUrl()}/rest/v1/openrefine_projects?${params.toString()}`, {
    method: "GET",
    headers: buildSupabaseHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to fetch openrefine_projects row");
    throw new ApiError(response.status, detail);
  }

  const rows = (await response.json()) as OpenRefineProjectRow[];
  if (!rows.length) {
    return null;
  }
  return mapProjectRow(rows[0]);
}

export async function createOpenRefineSavedProject(
  accessToken: string,
  row: OpenRefineProjectInsert
): Promise<OpenRefineSavedProject> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/openrefine_projects`, {
    method: "POST",
    headers: {
      ...Object.fromEntries(buildSupabaseHeaders(accessToken, "application/json").entries()),
      prefer: "return=representation"
    },
    body: JSON.stringify(row),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to insert openrefine_projects row");
    throw new ApiError(response.status, detail);
  }

  const rows = (await response.json()) as OpenRefineProjectRow[];
  if (!rows.length) {
    throw new ApiError(502, "Supabase insert did not return created row");
  }
  return mapProjectRow(rows[0]);
}

export async function deleteOpenRefineSavedProject(accessToken: string, userId: string, projectId: string): Promise<void> {
  const params = new URLSearchParams();
  params.set("id", `eq.${projectId}`);
  params.set("user_id", `eq.${userId}`);

  const response = await fetch(`${supabaseUrl()}/rest/v1/openrefine_projects?${params.toString()}`, {
    method: "DELETE",
    headers: buildSupabaseHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to delete openrefine_projects row");
    throw new ApiError(response.status, detail);
  }
}

export async function uploadOpenRefineArchive(
  accessToken: string,
  archivePath: string,
  archiveBody: ArrayBuffer
): Promise<void> {
  const bucket = openRefineProjectBucket();
  const response = await fetch(`${supabaseUrl()}/storage/v1/object/${bucket}/${encodePath(archivePath)}`, {
    method: "POST",
    headers: {
      ...Object.fromEntries(buildSupabaseHeaders(accessToken, "application/gzip").entries()),
      "x-upsert": "false"
    },
    body: archiveBody,
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to upload archive to Supabase Storage");
    throw new ApiError(response.status, detail);
  }
}

function parseDataUri(dataUri: string): { contentType: string; bytes: ArrayBuffer } {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new ApiError(400, "thumbnail must be a base64 Data URI");
  }
  const contentType = match[1];
  const decoded = Buffer.from(match[2], "base64");
  const buffer = new Uint8Array(decoded.length);
  buffer.set(decoded);
  const bytes = buffer.buffer;
  return { contentType, bytes };
}

export async function uploadOpenRefineThumbnailFromDataUri(
  accessToken: string,
  thumbnailPath: string,
  dataUri: string
): Promise<void> {
  const { contentType, bytes } = parseDataUri(dataUri);
  const bucket = openRefineProjectBucket();

  const response = await fetch(`${supabaseUrl()}/storage/v1/object/${bucket}/${encodePath(thumbnailPath)}`, {
    method: "POST",
    headers: {
      ...Object.fromEntries(buildSupabaseHeaders(accessToken, contentType).entries()),
      "x-upsert": "true"
    },
    body: bytes,
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to upload thumbnail to Supabase Storage");
    throw new ApiError(response.status, detail);
  }
}

export async function downloadOpenRefineArchive(accessToken: string, archivePath: string): Promise<ArrayBuffer> {
  const bucket = openRefineProjectBucket();
  const response = await fetch(`${supabaseUrl()}/storage/v1/object/${bucket}/${encodePath(archivePath)}`, {
    method: "GET",
    headers: buildSupabaseHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await parseSupabaseError(response, "Failed to download archive from Supabase Storage");
    throw new ApiError(response.status, detail);
  }

  return response.arrayBuffer();
}

export async function deleteOpenRefineStorageObject(accessToken: string, path: string): Promise<void> {
  const bucket = openRefineProjectBucket();
  const response = await fetch(`${supabaseUrl()}/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: "DELETE",
    headers: buildSupabaseHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok && response.status !== 404) {
    const detail = await parseSupabaseError(response, "Failed to delete object from Supabase Storage");
    throw new ApiError(response.status, detail);
  }
}
