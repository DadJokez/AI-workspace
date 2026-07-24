import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  return NextResponse.json({ user: session.user });
}
