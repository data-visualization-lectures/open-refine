import { ApiError } from "@/lib/api-error";
import {
  assertCronAuthorization,
  buildBackendHeaders,
  ensureCsrfHeader,
  parseMaxProjectAgeHours
} from "@/lib/proxy";
import { listStaleProjectIds, removeProjectForCleanup } from "@/lib/project-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    assertCronAuthorization(request);

    const maxAgeHours = parseMaxProjectAgeHours();
    // listStaleProjectIds uses the service role key to read across all users
    const staleProjectIds = await listStaleProjectIds(maxAgeHours);
    const backendBase = process.env.OPENREFINE_BACKEND_URL;
    if (!backendBase) {
      throw new ApiError(500, "Missing environment variable: OPENREFINE_BACKEND_URL");
    }

    const deleted: string[] = [];
    const failed: Array<{ projectId: string; reason: string }> = [];

    for (const projectId of staleProjectIds) {
      const backendUrl = new URL("/command/core/delete-project", backendBase);
      backendUrl.searchParams.set("project", projectId);
      // Backend auth relies solely on OPENREFINE_SHARED_SECRET (x-openrefine-proxy-secret).
      // No user cookie is needed for the cron context.
      const headers = buildBackendHeaders(request);
      await ensureCsrfHeader(request, headers, "POST");

      const backendResponse = await fetch(backendUrl, {
        method: "POST",
        headers,
        cache: "no-store"
      });

      if (backendResponse.ok) {
        try {
          await removeProjectForCleanup(projectId);
          deleted.push(projectId);
        } catch (removeError) {
          const reason = removeError instanceof Error ? removeError.message : "registry removal failed";
          failed.push({ projectId, reason });
        }
      } else {
        failed.push({
          projectId,
          reason: `status ${backendResponse.status}`
        });
      }
    }

    return Response.json({
      checked: staleProjectIds.length,
      deleted,
      failed
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
