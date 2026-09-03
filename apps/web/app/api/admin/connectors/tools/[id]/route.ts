import { auditLog, getDb, toolsCatalog } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const policy = body.policy;
  const enabled = body.enabled;
  if (!(["always_allow", "needs_approval", "blocked"] as const).includes(policy as never)) {
    return NextResponse.json({ error: "invalid_policy" }, { status: 400 });
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_enabled" }, { status: 400 });
  }

  const { id } = await params;
  const db = getDb();
  const priorRows = await db
    .select({
      id: toolsCatalog.id,
      provider: toolsCatalog.provider,
      toolName: toolsCatalog.toolName,
      policy: toolsCatalog.policy,
      enabled: toolsCatalog.enabled,
    })
    .from(toolsCatalog)
    .where(eq(toolsCatalog.id, id))
    .limit(1);
  const prior = priorRows[0];
  if (!prior) {
    return NextResponse.json({ error: "tool_not_found" }, { status: 404 });
  }

  const now = new Date();
  const updated = await db
    .update(toolsCatalog)
    .set({ policy: policy as typeof prior.policy, enabled, updatedAt: now })
    .where(eq(toolsCatalog.id, id))
    .returning({
      id: toolsCatalog.id,
      policy: toolsCatalog.policy,
      enabled: toolsCatalog.enabled,
    });
  await db.insert(auditLog).values({
    actorUserId: auth.user.id,
    actionType: "connector.tool_policy_updated",
    status: "succeeded",
    provider: prior.provider,
    toolName: prior.toolName,
    input: { toolCatalogId: id },
    metadata: {
      previous: { policy: prior.policy, enabled: prior.enabled },
      next: { policy, enabled },
    },
    startedAt: now,
    completedAt: now,
  });
  return NextResponse.json({ tool: updated[0] });
}
