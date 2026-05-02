import { pingDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> =
    {};

  try {
    const ms = await pingDb();
    checks.db = { ok: true, latencyMs: ms };
  } catch (err) {
    checks.db = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      service: "ai-workspace-web",
      checks,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
