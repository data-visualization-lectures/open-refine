import { ApiError } from "@/lib/api-error";
import { requireAuthenticatedUser } from "@/lib/auth";
import {
  deleteOpenRefineSavedProject,
  deleteOpenRefineStorageObject,
  getOpenRefineSavedProject
} from "@/lib/openrefine-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: { id: string };
};

function normalizeSavedProjectId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new ApiError(400, "Saved project id is required");
  }
  return value;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const id = normalizeSavedProjectId(context.params.id);
    const project = await getOpenRefineSavedProject(user.accessToken, user.id, id);
    if (!project) {
      throw new ApiError(404, "Saved project not found");
    }

    return Response.json({ project });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser(request);
    const id = normalizeSavedProjectId(context.params.id);
    const project = await getOpenRefineSavedProject(user.accessToken, user.id, id);
    if (!project) {
      throw new ApiError(404, "Saved project not found");
    }

    await deleteOpenRefineSavedProject(user.accessToken, user.id, id);

    const warnings: string[] = [];
    await deleteOpenRefineStorageObject(user.accessToken, project.archivePath).catch((error: unknown) => {
      warnings.push(error instanceof Error ? error.message : "Failed to delete archive from storage");
    });
    if (project.thumbnailPath) {
      await deleteOpenRefineStorageObject(user.accessToken, project.thumbnailPath).catch((error: unknown) => {
        warnings.push(error instanceof Error ? error.message : "Failed to delete thumbnail from storage");
      });
    }

    return Response.json({ deleted: true, id, warnings });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

