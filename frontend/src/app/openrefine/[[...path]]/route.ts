import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { sanitizeOpenRefineCookieHeader } from "@/lib/proxy";

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

async function authorizeOpenRefineUi(request: Request): Promise<void> {
  try {
    await requireAuthenticatedUser(request);
  } catch (error) {
    if (allowAnonymousUiProxy() && error instanceof ApiError && error.status === 401) {
      return;
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

function isRootOpenRefinePath(pathSegments: string[] | undefined): boolean {
  return !pathSegments || pathSegments.length === 0;
}

async function proxy(request: Request, params: { path?: string[] }): Promise<Response> {
  try {
    await authorizeOpenRefineUi(request);
    const targetUrl = buildTargetUrl(params.path, request.url);
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

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
      const rewrittenHtml = isRootOpenRefinePath(params.path) ? injectBaseHref(html) : html;
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
