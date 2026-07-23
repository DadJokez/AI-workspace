import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { buildDigest } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * "Since you were last here" rollup. Reading it advances the caller's
 * digest cursor, so each view covers exactly the gap since the previous one.
 */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const digest = await buildDigest(getDb(), sessionUser.id);
  return NextResponse.json({ digest });
}
