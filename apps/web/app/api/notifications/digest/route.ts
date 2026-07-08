import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { buildDigest } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * "Since you were last here" rollup. Reading it advances the caller's
 * digest cursor, so each view covers exactly the gap since the previous one.
 */
export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const digest = await buildDigest(getDb(), sessionUser.id);
  return NextResponse.json({ digest });
}
