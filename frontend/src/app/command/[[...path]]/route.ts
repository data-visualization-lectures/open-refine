import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { buildBackendHeaders, ensureCsrfHeader } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  try {
    await authorize(request);
    const targetUrl = buildTargetUrl(context.params.path, request.url);
    const method = request.method.toUpperCase();
    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, method);
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store"
    });

    const responseHeaders = new Headers(upstream.headers);
    return new Response(upstream.body, {
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
