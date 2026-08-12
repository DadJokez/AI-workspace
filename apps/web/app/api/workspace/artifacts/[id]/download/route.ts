import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const sessionUser = session.user;

    const access = await resolveArtifactReviewAccess({
      db: getDb(),
      actor: sessionUser,
      artifactId: id,
    });
    if (!access) {
      return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
    }
    const artifact = access.artifact;

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
