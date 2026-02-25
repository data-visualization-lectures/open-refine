import { ApiError } from "@/lib/api-error";

function requiredEnvAny(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new ApiError(500, `Missing environment variable: ${names.join(" or ")}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ApiError(500, `Missing environment variable: ${name}`);
  return value;
}

function supabaseUrl(): string {
  return requiredEnvAny(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]).replace(/\/$/, "");
}

function supabaseAnonKey(): string {
  return requiredEnvAny([
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
  ]);
}

function buildUserHeaders(accessToken: string): Headers {
  const headers = new Headers();
  headers.set("apikey", supabaseAnonKey());
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("content-type", "application/json");
  return headers;
}

function buildServiceHeaders(): Headers {
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = new Headers();
  headers.set("apikey", serviceKey);
  headers.set("authorization", `Bearer ${serviceKey}`);
  headers.set("content-type", "application/json");
  return headers;
}

const TABLE = "openrefine_runtime_projects";

/**
 * Registers (or refreshes) a project in the persistent registry.
 * Uses upsert so repeated calls on the same project_id are idempotent.
 * If the project_id is already owned by a different user, RLS blocks the
 * UPDATE and Supabase returns an error — callers should treat this as 403.
 * No-ops when accessToken is absent (anonymous mode).
 */
export async function registerProject(
  projectId: string,
  ownerId: string,
  projectName: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) return;

  const url = `${supabaseUrl()}/rest/v1/${TABLE}?on_conflict=project_id`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(buildUserHeaders(accessToken).entries()),
      prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      project_id: projectId,
      owner_id: ownerId,
      project_name: projectName,
      last_access_at: new Date().toISOString()
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new ApiError(
      response.status === 403 ? 403 : response.status,
      `Failed to register project ${projectId}`
    );
  }
}

/**
 * Updates last_access_at for the given project, only if it is owned by ownerId.
 * The WHERE clause (project_id + owner_id) double-checks ownership at the SQL level
 * in addition to the RLS UPDATE policy. Non-fatal: logs on failure rather than throwing.
 */
export async function touchProject(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) return;

  const params = new URLSearchParams();
  params.set("project_id", `eq.${projectId}`);
  params.set("owner_id", `eq.${ownerId}`);

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "PATCH",
    headers: {
      ...Object.fromEntries(buildUserHeaders(accessToken).entries()),
      prefer: "return=minimal"
    },
    body: JSON.stringify({ last_access_at: new Date().toISOString() }),
    cache: "no-store"
  });

  if (!response.ok) {
    console.error(`Failed to touch project ${projectId}: status ${response.status}`);
  }
}

/**
 * Returns true when projectId is owned by ownerId in the persistent registry.
 * RLS SELECT policy ensures a user can only see their own rows; the explicit
 * owner_id filter adds a SQL-level double-check.
 * Returns false when accessToken is absent (anonymous mode).
 */
export async function projectBelongsTo(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<boolean> {
  if (!accessToken) return false;

  const params = new URLSearchParams();
  params.set("project_id", `eq.${projectId}`);
  params.set("owner_id", `eq.${ownerId}`);
  params.set("select", "project_id");
  params.set("limit", "1");

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "GET",
    headers: buildUserHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) return false;

  const rows = (await response.json()) as { project_id: string }[];
  return rows.length > 0;
}

/**
 * Returns all project IDs owned by ownerId, ordered by most recently accessed.
 * Returns an empty array when accessToken is absent (anonymous mode).
 */
export async function listOwnedProjectIds(ownerId: string, accessToken?: string): Promise<string[]> {
  if (!accessToken) return [];

  const params = new URLSearchParams();
  params.set("owner_id", `eq.${ownerId}`);
  params.set("select", "project_id");
  params.set("order", "last_access_at.desc");

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "GET",
    headers: buildUserHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok) return [];

  const rows = (await response.json()) as { project_id: string }[];
  return rows.map((r) => r.project_id);
}

/**
 * Removes a project from the registry for the authenticated user.
 * No-ops when accessToken is absent (anonymous mode).
 */
export async function removeProject(
  projectId: string,
  ownerId: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) return;

  const params = new URLSearchParams();
  params.set("project_id", `eq.${projectId}`);
  params.set("owner_id", `eq.${ownerId}`);

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "DELETE",
    headers: buildUserHeaders(accessToken),
    cache: "no-store"
  });

  if (!response.ok && response.status !== 404) {
    throw new ApiError(response.status, `Failed to remove project ${projectId}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup-only functions (service role — bypasses RLS for cross-user operations)
// ---------------------------------------------------------------------------

/**
 * Returns project IDs whose last_access_at is older than maxAgeHours.
 * Uses the service role key to read across all users.
 */
export async function listStaleProjectIds(maxAgeHours: number): Promise<string[]> {
  const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams();
  params.set("last_access_at", `lte.${threshold}`);
  params.set("select", "project_id");

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "GET",
    headers: buildServiceHeaders(),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new ApiError(response.status, "Failed to list stale projects");
  }

  const rows = (await response.json()) as { project_id: string }[];
  return rows.map((r) => r.project_id);
}

/**
 * Removes a project from the registry during cleanup.
 * Uses the service role key to delete across all users.
 */
export async function removeProjectForCleanup(projectId: string): Promise<void> {
  const params = new URLSearchParams();
  params.set("project_id", `eq.${projectId}`);

  const response = await fetch(`${supabaseUrl()}/rest/v1/${TABLE}?${params}`, {
    method: "DELETE",
    headers: buildServiceHeaders(),
    cache: "no-store"
  });

  if (!response.ok && response.status !== 404) {
    throw new ApiError(response.status, `Failed to remove project ${projectId} during cleanup`);
  }
}
