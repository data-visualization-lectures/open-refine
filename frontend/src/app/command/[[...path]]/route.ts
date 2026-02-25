import { ApiError } from "@/lib/api-error";
import { type AuthenticatedUser, requireAuthenticatedUser } from "@/lib/auth";
import { downloadOpenRefineArchive, listOpenRefineSavedProjects, type OpenRefineSavedProject } from "@/lib/openrefine-storage";
import { parseProjectIdFromBody, parseProjectIdFromLocation } from "@/lib/openrefine-project-id";
import { registerProject, projectBelongsTo, touchProject, listOwnedProjectIds } from "@/lib/project-registry";
import {
  buildBackendHeaders,
  ensureCsrfHeader,
  filterProjectMetadata,
  parseProjectId,
  shouldEnforceProjectOwnership
} from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const CLOUD_SYNC_THROTTLE_MS = 30 * 1000;

type SyncThrottleStore = Map<string, number>;

declare global {
  var __openRefineCloudSyncThrottle__: SyncThrottleStore | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

function getSyncThrottleStore(): SyncThrottleStore {
  if (!globalThis.__openRefineCloudSyncThrottle__) {
    globalThis.__openRefineCloudSyncThrottle__ = new Map<string, number>();
  }
  return globalThis.__openRefineCloudSyncThrottle__;
}

function shouldRunCloudSync(userId: string): boolean {
  const store = getSyncThrottleStore();
  const now = Date.now();
  const last = store.get(userId) ?? 0;
  if (now - last < CLOUD_SYNC_THROTTLE_MS) {
    return false;
  }
  store.set(userId, now);
  return true;
}

function allowAnonymousUiProxy(): boolean {
  return process.env.ALLOW_ANON_OPENREFINE_UI === "true" || process.env.ALLOW_ANON_PROJECT_CREATE === "true";
}

async function authorize(request: Request): Promise<AuthenticatedUser | null> {
  try {
    return await requireAuthenticatedUser(request);
  } catch (error) {
    if (allowAnonymousUiProxy() && error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

function buildTargetUrl(pathSegments: string[] | undefined, requestUrl: string): URL {
  const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
  const incomingUrl = new URL(requestUrl);
  const path = `/command/${(pathSegments ?? []).join("/")}`;
  const targetUrl = new URL(path, backendBase);
  targetUrl.search = incomingUrl.search;
  return targetUrl;
}

type RouteContext = {
  params: { path?: string[] };
};

type AllMetadataResponse = {
  projects?: Record<
    string,
    {
      name?: string;
    }
  >;
};

function resolveDefaultOpenRefineLang(): string {
  const explicit = process.env.OPENREFINE_DEFAULT_UI_LANG?.trim();
  if (explicit) {
    return explicit;
  }

  const acceptLanguage = process.env.OPENREFINE_DEFAULT_ACCEPT_LANGUAGE?.trim();
  if (acceptLanguage) {
    const firstToken = acceptLanguage.split(",")[0]?.trim();
    if (firstToken) {
      const normalized = firstToken.split(";")[0]?.trim();
      if (normalized) {
        return normalized.split(/[-_]/)[0] ?? "ja";
      }
    }
  }

  return "ja";
}

async function buildRequestBodyForCommand(
  request: Request,
  method: string,
  command: string
): Promise<string | ArrayBuffer | undefined> {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  if (method === "POST" && command === "load-language") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const rawBody = await request.text();
      const params = new URLSearchParams(rawBody);
      if (!params.has("lang")) {
        params.set("lang", resolveDefaultOpenRefineLang());
      }
      return params.toString();
    }
  }

  return request.arrayBuffer();
}

function makeCloudSyncProjectName(saved: OpenRefineSavedProject): string {
  const base = saved.name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const safeBase = base.replace(/[<>\\/:|?*]/g, " ").replace(/\s+/g, " ").trim();
  const shortId = saved.id.slice(0, 8);
  const head = (safeBase || "OpenRefine Project").slice(0, 96).trim();
  return `${head} [cloud:${shortId}]`;
}

async function importArchiveToOpenRefine(
  request: Request,
  archive: ArrayBuffer,
  projectName: string
): Promise<string | null> {
  const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
  const backendUrl = new URL("/command/core/import-project", backendBase);
  const headers = buildBackendHeaders(request);
  await ensureCsrfHeader(request, headers, "POST");
  const csrfToken = headers.get("x-token");
  if (csrfToken) {
    backendUrl.searchParams.set("csrf_token", csrfToken);
  }
  headers.delete("content-type");

  const form = new FormData();
  form.append("project-file", new Blob([archive], { type: "application/gzip" }), `${projectName}.openrefine.tar.gz`);
  form.append("project-name", projectName);

  const response = await fetch(backendUrl, {
    method: "POST",
    headers,
    body: form,
    redirect: "manual",
    cache: "no-store"
  });
  if (!response.ok && response.status !== 302) {
    const reason = await response.text();
    throw new ApiError(response.status, `OpenRefine import-project failed: ${reason}`);
  }

  const fromLocation = parseProjectIdFromLocation(response.headers.get("location"));
  const fromUrl = parseProjectIdFromLocation(response.url);
  if (fromLocation || fromUrl) {
    return fromLocation ?? fromUrl;
  }

  const body = await response.text();
  return parseProjectIdFromBody(body);
}

async function syncCloudProjectsToOpenRefineIfNeeded(request: Request, user: AuthenticatedUser): Promise<void> {
  if (!shouldRunCloudSync(user.id)) {
    return;
  }

  const savedProjects = await listOpenRefineSavedProjects(user.accessToken, user.id);
  if (!savedProjects.length) {
    return;
  }

  const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
  const metaUrl = new URL("/command/core/get-all-project-metadata", backendBase);
  const metaHeaders = buildBackendHeaders(request);
  metaHeaders.delete("content-type");

  const metaResponse = await fetch(metaUrl, {
    method: "GET",
    headers: metaHeaders,
    cache: "no-store"
  });
  const metadata: AllMetadataResponse = metaResponse.ok ? ((await metaResponse.json()) as AllMetadataResponse) : {};

  const existingNames = new Set<string>();
  for (const project of Object.values(metadata.projects ?? {})) {
    const name = project?.name?.trim();
    if (name) {
      existingNames.add(name);
    }
  }

  let imported = 0;
  const maxImportsPerSync = 3;
  for (const saved of savedProjects) {
    const syncName = makeCloudSyncProjectName(saved);
    if (existingNames.has(syncName)) {
      continue;
    }
    const archive = await downloadOpenRefineArchive(user.accessToken, saved.archivePath);
    const importedProjectId = await importArchiveToOpenRefine(request, archive, syncName);
    if (importedProjectId) {
      await registerProject(importedProjectId, user.id, syncName, user.accessToken);
    }
    existingNames.add(syncName);
    imported += 1;
    if (imported >= maxImportsPerSync) {
      break;
    }
  }
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await authorize(request);
    const targetUrl = buildTargetUrl(context.params.path, request.url);
    const method = request.method.toUpperCase();
    const command = (context.params.path ?? []).filter(Boolean).at(-1) ?? "";

    // Ownership enforcement for project-scoped commands
    if (user && shouldEnforceProjectOwnership(command, request.url)) {
      const projectId = parseProjectId(request.url);
      if (!projectId) {
        throw new ApiError(400, "project query parameter is required");
      }
      if (!(await projectBelongsTo(projectId, user.id, user.accessToken))) {
        throw new ApiError(403, "Project does not belong to the authenticated user");
      }
      await touchProject(projectId, user.id, user.accessToken);
    }

    if (user && method === "GET" && command === "get-all-project-metadata") {
      // Fire-and-forget: do not block the response waiting for cloud sync.
      syncCloudProjectsToOpenRefineIfNeeded(request, user).catch((syncError) => {
        console.error("Failed to sync cloud projects for metadata listing", syncError);
      });
    }

    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, method);
    const body = await buildRequestBodyForCommand(request, method, command);

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store"
    });

    // Detect project creation: register the new project ID before forwarding
    // so that subsequent get-project-metadata / get-models pass the ownership check.
    const rawLocation = upstream.headers.get("location");
    if (user && rawLocation && upstream.status >= 300 && upstream.status < 400) {
      const newProjectId = parseProjectIdFromLocation(rawLocation);
      if (newProjectId) {
        await registerProject(newProjectId, user.id, newProjectId, user.accessToken).catch(
          (err: unknown) => {
            console.error("[command proxy] Failed to register new project after creation", err);
          }
        );
      }
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(lowered)) {
        continue;
      }
      if (lowered === "content-length" || lowered === "content-encoding") {
        continue;
      }
      responseHeaders.append(key, value);
    }

    const upstreamBody = await upstream.arrayBuffer();

    // Filter get-all-project-metadata to owned projects only
    if (user && method === "GET" && command === "get-all-project-metadata" && upstream.ok) {
      const ownedIds = await listOwnedProjectIds(user.id, user.accessToken);
      const filteredBody = filterProjectMetadata(upstreamBody, ownedIds);
      return new Response(filteredBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    }

    return new Response(upstreamBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function OPTIONS(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
