import { NextResponse } from "next/server";
import { getDb } from "@ai-workspace/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const timestamp = new Date().toISOString();
  const dbCheck = await checkDb();
  const runtimeCheck = checkRuntime();
  const status =
    dbCheck.ok && runtimeCheck.ok
      ? "ok"
      : dbCheck.ok
        ? "degraded"
        : "unhealthy";

  return NextResponse.json(
    {
      status,
      service: "ai-workspace-web",
      timestamp,
      checks: {
        db: dbCheck,
        runtime: runtimeCheck,
      },
    },
    { status: status === "unhealthy" ? 503 : 200 },
  );
}

async function checkDb(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = performance.now();
  try {
    await getDb().execute(sql`select 1`);
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.name : "DatabaseError",
    };
  }
}

function checkRuntime(): {
  ok: boolean;
  name: "bedrock" | "cursor";
  configured: boolean;
  warning?: string;
} {
  const name = process.env.RUNTIME === "bedrock" ? "bedrock" : "cursor";
  if (name === "cursor") {
    const configured = Boolean(process.env.CURSOR_API_KEY);
    return {
      ok: configured,
      name,
      configured,
      ...(configured ? {} : { warning: "CURSOR_API_KEY is not configured" }),
    };
  }

  const configured = Boolean(
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  );
  return {
    ok: configured,
    name,
    configured,
    ...(configured
      ? {}
      : { warning: "AWS_REGION/AWS_DEFAULT_REGION is not configured" }),
  };
}
