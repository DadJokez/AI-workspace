import { auditLog, getDb, mcpServers } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

type ConnectorStatus = "active" | "disabled" | "planned";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const body = await readJson(req);
  const parsed = parseConnectorPatch(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_connector_update", message: parsed.message },
      { status: 400 },
    );
  }

  const { id } = await params;
  const db = getDb();
  const priorRows = await db
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      status: mcpServers.status,
      ownerUserId: mcpServers.ownerUserId,
      credentialType: mcpServers.credentialType,
      credentialTtlSeconds: mcpServers.credentialTtlSeconds,
      lastRotatedAt: mcpServers.lastRotatedAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  const prior = priorRows[0];
  if (!prior) {
    return NextResponse.json({ error: "connector_not_found" }, { status: 404 });
  }

  const now = new Date();
  const statusChanged = parsed.values.status !== undefined && parsed.values.status !== prior.status;
  const update = {
    ...parsed.values,
    ...(statusChanged && parsed.values.status === "active"
      ? {
          enabledAt: now,
          enabledBy: auth.user.id,
          disabledAt: null,
          disabledBy: null,
          statusReason: parsed.reason,
        }
      : {}),
    ...(statusChanged && parsed.values.status !== "active"
      ? {
          disabledAt: now,
          disabledBy: auth.user.id,
          statusReason: parsed.reason,
        }
      : {}),
    updatedAt: now,
  };
  const updated = await db
    .update(mcpServers)
    .set(update)
    .where(eq(mcpServers.id, id))
    .returning({
      id: mcpServers.id,
      slug: mcpServers.slug,
      status: mcpServers.status,
      ownerUserId: mcpServers.ownerUserId,
      credentialType: mcpServers.credentialType,
      credentialTtlSeconds: mcpServers.credentialTtlSeconds,
      lastRotatedAt: mcpServers.lastRotatedAt,
    });

  const actionType = statusChanged
    ? parsed.values.status === "active"
      ? "connector.enabled"
      : "connector.disabled"
    : "connector.updated";
  await db.insert(auditLog).values({
    actorUserId: auth.user.id,
    actionType,
    status: "succeeded",
    provider: prior.slug,
    toolName: "connector_registry",
    input: { connectorId: id },
    metadata: {
      reason: parsed.reason,
      previous: prior,
      next: updated[0] ?? null,
    },
    startedAt: now,
    completedAt: now,
  });

  return NextResponse.json({ connector: updated[0] });
}

function parseConnectorPatch(body: Record<string, unknown>):
  | {
      ok: true;
      reason: string | null;
      values: {
        status?: ConnectorStatus;
        ownerUserId?: string | null;
        credentialType?: string | null;
        credentialTtlSeconds?: number | null;
        lastRotatedAt?: Date | null;
      };
    }
  | { ok: false; message: string } {
  const values: {
    status?: ConnectorStatus;
    ownerUserId?: string | null;
    credentialType?: string | null;
    credentialTtlSeconds?: number | null;
    lastRotatedAt?: Date | null;
  } = {};
  if (body.status !== undefined) {
    if (!(["active", "disabled", "planned"] as const).includes(body.status as ConnectorStatus)) {
      return { ok: false, message: "Choose an active, disabled, or planned state." };
    }
    values.status = body.status as ConnectorStatus;
  }
  if (body.ownerUserId !== undefined) {
    if (body.ownerUserId !== null && (typeof body.ownerUserId !== "string" || !isUuid(body.ownerUserId))) {
      return { ok: false, message: "Choose a valid connector owner." };
    }
    values.ownerUserId = body.ownerUserId as string | null;
  }
  if (body.credentialType !== undefined) {
    if (body.credentialType !== null && typeof body.credentialType !== "string") {
      return { ok: false, message: "Credential type must be text." };
    }
    const credentialType = typeof body.credentialType === "string"
      ? body.credentialType.trim().slice(0, 100)
      : null;
    values.credentialType = credentialType || null;
  }
  if (body.credentialTtlSeconds !== undefined) {
    if (body.credentialTtlSeconds !== null && (!Number.isInteger(body.credentialTtlSeconds) || Number(body.credentialTtlSeconds) < 60 || Number(body.credentialTtlSeconds) > 31_536_000)) {
      return { ok: false, message: "Credential TTL must be between 60 seconds and 365 days." };
    }
    values.credentialTtlSeconds = body.credentialTtlSeconds as number | null;
  }
  if (body.lastRotatedAt !== undefined) {
    if (body.lastRotatedAt === null || body.lastRotatedAt === "") {
      values.lastRotatedAt = null;
    } else if (typeof body.lastRotatedAt === "string" && Number.isFinite(Date.parse(body.lastRotatedAt))) {
      values.lastRotatedAt = new Date(body.lastRotatedAt);
    } else {
      return { ok: false, message: "Last rotated must be a valid date." };
    }
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
  if (values.status !== undefined && values.status !== "active" && (!reason || reason.length < 3)) {
    return { ok: false, message: "Give a brief reason before disabling a connector." };
  }
  if (Object.keys(values).length === 0) {
    return { ok: false, message: "No connector fields were supplied." };
  }
  return { ok: true, reason, values };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
