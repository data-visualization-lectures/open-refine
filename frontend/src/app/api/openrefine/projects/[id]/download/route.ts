import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import { downloadOpenRefineArchive, getOpenRefineSavedProject } from "@/lib/openrefine-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: { id: string };
};

function fileSafeName(value: string): string {
  const compact = value.trim().replace(/\s+/g, "-");
  const safe = compact.replace(/[^A-Za-z0-9._-]/g, "");
  return safe || "openrefine-project";
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const savedProjectId = context.params.id.trim();
    if (!savedProjectId) {
      throw new ApiError(400, "Saved project id is required");
    }

    const project = await getOpenRefineSavedProject(user.accessToken, user.id, savedProjectId);
    if (!project) {
      throw new ApiError(404, "Saved project not found");
    }

    const archive = await downloadOpenRefineArchive(user.accessToken, project.archivePath);
    const downloadName = `${fileSafeName(project.name)}.openrefine.tar.gz`;

    return new Response(archive, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${downloadName}"`,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

