import { auditLog, getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  parseDeniedDomainInput,
  saveWebEgressPolicy,
} from "@/lib/web-egress-policy";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const deniedDomains =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { deniedDomains?: unknown }).deniedDomains
      : undefined;
  const parsed = parseDeniedDomainInput(deniedDomains);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "invalid_denied_domains",
        message:
          "Use bare domains only, without a protocol, port, path, spaces, or wildcard.",
        invalid: parsed.invalid,
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const policy = await saveWebEgressPolicy(db, parsed.domains);
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId: auth.user.id,
    actionType: "admin_web_egress_policy_update",
    status: "succeeded",
    provider: "builtin",
    toolName: "web_egress_policy",
    input: { deniedDomainCount: policy.deniedDomains.length },
    metadata: {
      policy: policy.name,
      deniedDomains: policy.deniedDomains,
    },
    startedAt: now,
    completedAt: now,
  });

  return NextResponse.json({ policy });
}
