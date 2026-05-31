import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  loadWorkspaceArtifactForUser,
  serializeWorkspaceArtifactDetail,
} from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const artifact = await loadWorkspaceArtifactForUser({
      db: getDb(),
      userId: sessionUser.id,
      artifactId: id,
    });
    if (!artifact) {
      return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
    }

    return NextResponse.json({
      artifact: serializeWorkspaceArtifactDetail(artifact),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}
