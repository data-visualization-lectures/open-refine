import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { buildBackendHeaders, ensureCsrfHeader } from "@/lib/proxy";

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

async function authorize(request: Request): Promise<void> {
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
  const incomingUrl = new URL(requestUrl);
  const path = `/command/${(pathSegments ?? []).join("/")}`;
  const targetUrl = new URL(path, backendBase);
  targetUrl.search = incomingUrl.search;
  return targetUrl;
}

type RouteContext = {
  params: { path?: string[] };
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

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  try {
    await authorize(request);
    const targetUrl = buildTargetUrl(context.params.path, request.url);
    const method = request.method.toUpperCase();
    const command = context.params.path?.[context.params.path.length - 1] ?? "";
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
