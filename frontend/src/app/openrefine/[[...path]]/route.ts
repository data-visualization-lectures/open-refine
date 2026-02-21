import { ApiError } from "@/lib/api-error";
import { type AuthenticatedUser, requireAuthenticatedUser } from "@/lib/auth";
import {
  createOpenRefineSavedProject,
  deleteOpenRefineStorageObject,
  downloadOpenRefineArchive,
  listOpenRefineSavedProjects,
  type OpenRefineSavedProject,
  uploadOpenRefineArchive
} from "@/lib/openrefine-storage";
import { projectBelongsTo, registerProject } from "@/lib/project-registry";
import { buildBackendHeaders, ensureCsrfHeader, parseMaxUploadSizeMb, sanitizeOpenRefineCookieHeader } from "@/lib/proxy";

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

function allowAnonymousUiProxy(): boolean {
  return process.env.ALLOW_ANON_OPENREFINE_UI === "true" || process.env.ALLOW_ANON_PROJECT_CREATE === "true";
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

async function authorizeOpenRefineUi(request: Request): Promise<AuthenticatedUser | null> {
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
  const path = `/${(pathSegments ?? []).join("/")}`;
  const incomingUrl = new URL(requestUrl);
  const targetUrl = new URL(path, backendBase);
  targetUrl.search = incomingUrl.search;
  return targetUrl;
}

function buildProxyHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    const lowered = key.toLowerCase();
    if (lowered === "host" || lowered === "connection" || lowered === "content-length" || lowered === "accept-encoding") {
      continue;
    }
    if (lowered === "x-openrefine-proxy-secret") {
      continue;
    }
    if (lowered === "cookie") {
      continue;
    }
    headers.set(key, value);
  }

  const filteredCookie = sanitizeOpenRefineCookieHeader(request.headers.get("cookie"));
  if (filteredCookie) {
    headers.set("cookie", filteredCookie);
  }

  // Keep OpenRefine initial UI language in Japanese by default.
  const defaultAcceptLanguage = process.env.OPENREFINE_DEFAULT_ACCEPT_LANGUAGE?.trim() || "ja-JP,ja;q=0.9,en;q=0.7";
  headers.set("accept-language", defaultAcceptLanguage);

  headers.set("x-openrefine-proxy-secret", requireEnv("OPENREFINE_SHARED_SECRET"));
  return headers;
}

function rewriteLocationForProxy(location: string | null): string | null {
  if (!location) {
    return null;
  }
  try {
    const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
    const parsed = new URL(location, backendBase);
    return `/openrefine${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return location;
  }
}

function injectBaseHref(html: string): string {
  if (html.includes("<base ")) {
    return html;
  }
  return html.replace("<head>", '<head>\n  <base href="/openrefine/">');
}

function rewriteHomeButtonHref(html: string): string {
  return html.replace(/(<a[^>]*id=["']app-home-button["'][^>]*href=["'])\.\/(["'][^>]*>)/i, "$1/$2");
}

function injectAuthScripts(html: string): string {
  if (html.includes("auth.dataviz.jp/lib/supabase.js")) {
    return html;
  }

  // This guard script runs before supabase.js and dataviz-auth-client.js load.
  // It prevents two known URL-manipulation patterns from disrupting OpenRefine's
  // Backbone.js hash-based router:
  //
  // (1) Supabase implicit grant cleanup: after extracting OAuth tokens from
  //     "#access_token=…" in the URL, supabase-js calls
  //     `window.location.hash = ""` which fires a `hashchange` event.
  //     Backbone responds by re-routing, which appears as a page reload.
  //     Fix: intercept hashchange in capture phase; if the new hash is empty
  //     and the old hash held auth tokens, stop the event before Backbone sees it.
  //
  // (2) dataviz-auth-client.js URL cleanup: after a login callback the script
  //     calls `history.replaceState({}, title, location.pathname)` to strip
  //     auth params from the URL. This removes the hash entirely, which can
  //     confuse interval-based routing or leave the address bar wrong.
  //     Fix: wrap replaceState so that when the incoming URL has no hash but
  //     the current location does, the existing hash is preserved.
  const guardScript = `<script>
(function () {
  'use strict';

  /* ── Guard 1: suppress hashchange caused by Supabase auth-token cleanup ── */
  window.addEventListener('hashchange', function (e) {
    var newHash = window.location.hash;
    var oldUrl  = e.oldURL || '';
    var hi      = oldUrl.indexOf('#');
    var oldFrag = hi >= 0 ? oldUrl.slice(hi + 1) : '';
    if ((!newHash || newHash === '#') && /access_token=/.test(oldFrag)) {
      e.stopImmediatePropagation();
    }
  }, true /* capture – runs before Backbone's listener */);

  /* ── Guard 2: keep hash intact when dataviz-auth-client strips the URL ── */
  var _origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (state, title, url) {
    if (typeof url === 'string' && url.indexOf('#') === -1 && window.location.hash) {
      url = url + window.location.hash;
    }
    return _origReplaceState(state, title, url);
  };
}());
</script>`;

  const injection =
    '  <style>body { padding-top: 48px !important; }</style>\n' +
    '  <script>window.DATAVIZ_HEADER_CONFIG = { mode: "public" };</script>\n' +
    guardScript + "\n" +
    '  <script src="https://auth.dataviz.jp/lib/supabase.js"></script>\n' +
    '  <script src="https://auth.dataviz.jp/lib/dataviz-auth-client.js"></script>';
  if (html.includes("</head>")) {
    return html.replace("</head>", `${injection}\n</head>`);
  }
  return html.replace("</body>", `${injection}\n</body>`);
}

function isRootOpenRefinePath(pathSegments: string[] | undefined): boolean {
  return !pathSegments || pathSegments.length === 0;
}

function isExportProjectCommand(pathSegments: string[] | undefined): boolean {
  if (!pathSegments || pathSegments.length < 4) {
    return false;
  }
  return pathSegments[0] === "command" && pathSegments[1] === "core" && pathSegments[2] === "export-project";
}

function isGetAllProjectMetadataCommand(pathSegments: string[] | undefined): boolean {
  if (!pathSegments || pathSegments.length < 3) {
    return false;
  }
  return pathSegments[0] === "command" && pathSegments[1] === "core" && pathSegments[2] === "get-all-project-metadata";
}

function normalizeSavedProjectName(exportFileSegment: string): string {
  const decoded = decodeURIComponent(exportFileSegment);
  const withoutArchiveExt = decoded.replace(/\.openrefine\.tar\.gz$/i, "").replace(/\.tar\.gz$/i, "").trim();
  if (withoutArchiveExt) {
    return withoutArchiveExt;
  }
  return "OpenRefine Project";
}

function resolveBackUrl(request: Request, openrefineProjectId: string | null): string {
  const referer = request.headers.get("referer");
  if (referer) {
    return referer;
  }
  if (openrefineProjectId) {
    return `/openrefine/project?project=${encodeURIComponent(openrefineProjectId)}`;
  }
  return "/openrefine/";
}

function renderAlertRedirectPage(message: string, targetUrl: string, status = 200): Response {
  const safeMessage = JSON.stringify(message);
  const safeTargetUrl = JSON.stringify(targetUrl);
  const html = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><title>OpenRefine</title></head>
  <body>
    <script>
      alert(${safeMessage});
      window.location.replace(${safeTargetUrl});
    </script>
  </body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

type ProjectMetadataResponse = {
  name?: string;
};

type AllMetadataResponse = {
  projects?: Record<
    string,
    {
      name?: string;
    }
  >;
};

function makeCloudSyncProjectName(saved: OpenRefineSavedProject): string {
  const base = saved.name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const safeBase = base.replace(/[<>\\/:|?*]/g, " ").replace(/\s+/g, " ").trim();
  const shortId = saved.id.slice(0, 8);
  const head = (safeBase || "OpenRefine Project").slice(0, 96).trim();
  return `${head} [cloud:${shortId}]`;
}

function parseProjectId(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/project=(\d+)/);
  return match?.[1] ?? null;
}

function parseProjectIdFromBody(raw: string): string | null {
  const fromQuery = parseProjectId(raw);
  if (fromQuery) {
    return fromQuery;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates = [parsed.project, parsed.projectID, parsed.projectId];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
      if (typeof candidate === "string") {
        if (/^\d+$/.test(candidate)) {
          return candidate;
        }
        const nested = parseProjectId(candidate);
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }

  return raw.match(/\/project\?project=(\d+)/)?.[1] ?? null;
}

async function fetchAllProjectMetadata(request: Request): Promise<AllMetadataResponse> {
  const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
  const url = new URL("/command/core/get-all-project-metadata", backendBase);
  const headers = buildBackendHeaders(request);
  headers.delete("content-type");

  const response = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store"
  });
  if (!response.ok) {
    const reason = await response.text();
    throw new ApiError(response.status, `Failed to fetch project metadata: ${reason}`);
  }
  return (await response.json()) as AllMetadataResponse;
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

  const fromLocation = parseProjectId(response.headers.get("location"));
  const fromUrl = parseProjectId(response.url);
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

  const metadata = await fetchAllProjectMetadata(request);
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
      registerProject(importedProjectId, user.id, syncName);
    }
    existingNames.add(syncName);
    imported += 1;
    if (imported >= maxImportsPerSync) {
      break;
    }
  }
}

async function resolveOwnedProjectNameFromBackend(request: Request, projectId: string): Promise<string | null> {
  const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
  const metadataUrl = new URL("/command/core/get-project-metadata", backendBase);
  metadataUrl.searchParams.set("project", projectId);

  const headers = buildProxyHeaders(request);
  headers.delete("content-type");

  const response = await fetch(metadataUrl, {
    method: "GET",
    headers,
    cache: "no-store"
  });
  if (!response.ok) {
    return null;
  }

  const metadata = (await response.json()) as ProjectMetadataResponse;
  const name = metadata.name?.trim() ?? "";
  return name || null;
}

async function exportArchiveFromOpenRefine(
  request: Request,
  pathSegments: string[],
  formBody: string
): Promise<ArrayBuffer> {
  const targetUrl = buildTargetUrl(pathSegments, request.url);
  const headers = buildProxyHeaders(request);
  headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");

  let upstream = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: formBody,
    redirect: "manual",
    cache: "no-store"
  });

  const isRedirect = upstream.status >= 300 && upstream.status < 400;
  const redirectLocation = upstream.headers.get("location");
  if (isRedirect && redirectLocation) {
    const backendBase = requireEnv("OPENREFINE_BACKEND_URL");
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

async function handleSupabaseProjectSaveFromExport(
  request: Request,
  pathSegments: string[] | undefined
): Promise<Response> {
  const formBody = await request.text();
  const form = new URLSearchParams(formBody);
  const openrefineProjectId = form.get("project");
  const backUrl = resolveBackUrl(request, openrefineProjectId);

  try {
    const user = await requireAuthenticatedUser(request);

    if (!openrefineProjectId || !/^\d+$/.test(openrefineProjectId)) {
      throw new ApiError(400, "プロジェクトIDの取得に失敗しました。");
    }
    if (!projectBelongsTo(openrefineProjectId, user.id)) {
      const resolvedName = await resolveOwnedProjectNameFromBackend(request, openrefineProjectId);
      if (!resolvedName) {
        throw new ApiError(403, "このプロジェクトを保存する権限がありません。");
      }
      registerProject(openrefineProjectId, user.id, resolvedName);
    }
    if (!pathSegments || pathSegments.length < 4) {
      throw new ApiError(400, "export-project path is invalid");
    }

    const exportFileSegment = pathSegments.slice(3).join("/");
    const projectName = normalizeSavedProjectName(exportFileSegment);
    const archive = await exportArchiveFromOpenRefine(request, pathSegments, formBody);

    const maxBytes = parseMaxUploadSizeMb() * 1024 * 1024;
    if (archive.byteLength > maxBytes) {
      throw new ApiError(413, "保存対象が MAX_UPLOAD_SIZE_MB を超えています。");
    }

    const savedProjectId = crypto.randomUUID();
    const archivePath = `${user.id}/${savedProjectId}/project.tar.gz`;

    await uploadOpenRefineArchive(user.accessToken, archivePath, archive);
    try {
      await createOpenRefineSavedProject(user.accessToken, {
        id: savedProjectId,
        user_id: user.id,
        name: projectName,
        archive_path: archivePath,
        source_filename: decodeURIComponent(exportFileSegment),
        size_bytes: archive.byteLength
      });
    } catch (error) {
      await deleteOpenRefineStorageObject(user.accessToken, archivePath).catch(() => undefined);
      throw error;
    }

    return renderAlertRedirectPage(`クラウドへ保存しました: ${projectName}`, backUrl, 200);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Unknown error";
    return renderAlertRedirectPage(`クラウド保存に失敗しました: ${message}`, backUrl, 500);
  }
}

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

function isLoadLanguageCommand(pathSegments: string[] | undefined): boolean {
  if (!pathSegments || pathSegments.length < 3) {
    return false;
  }
  return pathSegments[0] === "command" && pathSegments[1] === "core" && pathSegments[2] === "load-language";
}

async function buildOpenRefineProxyBody(
  request: Request,
  method: string,
  pathSegments: string[] | undefined
): Promise<string | ArrayBuffer | undefined> {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  if (method === "POST" && isLoadLanguageCommand(pathSegments)) {
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

async function proxy(request: Request, params: { path?: string[] }): Promise<Response> {
  try {
    const user = await authorizeOpenRefineUi(request);
    const targetUrl = buildTargetUrl(params.path, request.url);
    const method = request.method.toUpperCase();

    if (method === "POST" && isExportProjectCommand(params.path)) {
      return handleSupabaseProjectSaveFromExport(request, params.path);
    }

    if (user && method === "GET" && isGetAllProjectMetadataCommand(params.path)) {
      // Fire-and-forget: do not block the response waiting for cloud sync.
      // In Vercel's Node.js runtime the promise may be cut short when the
      // response is sent, but sync is best-effort and the next page load
      // will retry after CLOUD_SYNC_THROTTLE_MS anyway.
      syncCloudProjectsToOpenRefineIfNeeded(request, user).catch((syncError) => {
        console.error("Failed to sync cloud projects for metadata listing", syncError);
      });
    }

    const body = await buildOpenRefineProxyBody(request, method, params.path);

    const upstream = await fetch(targetUrl, {
      method,
      headers: buildProxyHeaders(request),
      body,
      redirect: "manual",
      cache: "no-store"
    });

    const headers = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      const lowered = key.toLowerCase();
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(lowered)) {
        continue;
      }
      if (lowered === "location") {
        const rewritten = rewriteLocationForProxy(value);
        if (rewritten) {
          headers.append("location", rewritten);
        }
        continue;
      }
      if (lowered === "content-length") {
        continue;
      }
      if (lowered === "content-encoding") {
        continue;
      }
      headers.append(key, value);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");

    if (isHtml) {
      const html = await upstream.text();
      const withBase = isRootOpenRefinePath(params.path) ? injectBaseHref(html) : html;
      const withHomeButton = rewriteHomeButtonHref(withBase);
      const rewrittenHtml = injectAuthScripts(withHomeButton);
      return new Response(rewrittenHtml, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers
      });
    }

    const upstreamBody = await upstream.arrayBuffer();
    return new Response(upstreamBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

type RouteContext = {
  params: { path?: string[] };
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}

export async function OPTIONS(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context.params);
}
