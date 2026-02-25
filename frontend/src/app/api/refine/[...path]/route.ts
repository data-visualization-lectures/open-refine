import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import {
  assertAllowedCommand,
  buildBackendHeaders,
  buildBackendUrl,
  ensureCsrfHeader,
  parseProjectId,
  relayBackendResponse,
  requiresProjectOwnership,
  resolveCommand
} from "@/lib/proxy";
import { projectBelongsTo, touchProject } from "@/lib/project-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: { path: string[] };
};

async function proxyRequest(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const command = resolveCommand(context.params.path);
    assertAllowedCommand(command);

    const projectId = parseProjectId(request.url);
    if (requiresProjectOwnership(command)) {
      if (!projectId) {
        throw new ApiError(400, "project query parameter is required");
      }
      if (!(await projectBelongsTo(projectId, user.id, user.accessToken))) {
        throw new ApiError(403, "Project does not belong to the authenticated user");
      }
      await touchProject(projectId, user.id, user.accessToken);
    }

    const backendUrl = buildBackendUrl(context.params.path, request.url);
    const method = request.method.toUpperCase();
    const headers = buildBackendHeaders(request);
    await ensureCsrfHeader(request, headers, method);
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    const backendResponse = await fetch(backendUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store"
    });

    return relayBackendResponse(backendResponse);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}
