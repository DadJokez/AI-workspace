import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { loadCommandPaletteIndex } from "@/lib/command-palette-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const startedAt = performance.now();
  const session = await requireSession();
  if ("error" in session) return session.error;

  const requestedThreadId = new URL(req.url).searchParams
    .get("threadId")
    ?.trim();
  const currentThreadId =
    requestedThreadId && requestedThreadId.length <= 128
      ? requestedThreadId
      : undefined;
  const index = await loadCommandPaletteIndex({
    db: getDb(),
    user: session.user,
    ...(currentThreadId ? { currentThreadId } : {}),
  });
  const durationMs = Math.max(0, performance.now() - startedAt);

  return NextResponse.json(
    {
      ...index,
      isAdmin: session.user.role === "admin",
      durationMs: Math.round(durationMs * 10) / 10,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Server-Timing": `command-palette;dur=${durationMs.toFixed(1)}`,
      },
    },
  );
}
