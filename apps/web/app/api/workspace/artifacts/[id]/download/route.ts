import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";

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

    const metadata = normalizeMetadata(artifact.metadata);
    const isBase64 = metadata?.storageEncoding === "base64";
    const body = isBase64
      ? Buffer.from(artifact.content, "base64")
      : artifact.content;
    return new Response(body, {
      headers: {
        "Content-Type": isBase64
          ? artifact.mimeType
          : `${artifact.mimeType}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${safeHeaderFilename(
          artifact.filename,
        )}"`,
        "Cache-Control": "private, no-store",
      },
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

function safeHeaderFilename(filename: string): string {
  return filename.replace(/["\r\n\\]/g, "_");
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
