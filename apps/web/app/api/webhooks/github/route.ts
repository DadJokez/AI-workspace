import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import {
  normalizeGitHubWebhookEvent,
  processGitHubWebhookEvent,
  verifyGitHubWebhookSignature,
  writeGitHubWebhookAudit,
} from "@/lib/github-event-triggers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUPPORTED_EVENTS = new Set(["pull_request_review", "workflow_run"]);

export async function POST(req: Request) {
  const db = getDb();
  const deliveryId = cleanHeader(req.headers.get("x-github-delivery"), 200);
  const eventType = cleanHeader(req.headers.get("x-github-event"), 80);
  const signature = req.headers.get("x-hub-signature-256");
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    await safeAudit(db, deliveryId, eventType, "failed", "Webhook secret is not configured.");
    return NextResponse.json({ error: "webhook_unavailable" }, { status: 503 });
  }
  if (!deliveryId || !eventType) {
    await safeAudit(db, deliveryId, eventType, "denied", "Required GitHub headers are missing.");
    return NextResponse.json({ error: "invalid_headers" }, { status: 400 });
  }

  const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    await safeAudit(db, deliveryId, eventType, "denied", "Webhook body exceeds the size limit.");
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const rawBody = Buffer.from(await req.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    await safeAudit(db, deliveryId, eventType, "denied", "Webhook body exceeds the size limit.");
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (!verifyGitHubWebhookSignature({ rawBody, signature, secret })) {
    await safeAudit(db, deliveryId, eventType, "denied", "GitHub signature verification failed.");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    await safeAudit(db, deliveryId, eventType, "failed", "Webhook body is not valid JSON.");
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (eventType === "ping") {
    await safeAudit(db, deliveryId, eventType, "succeeded");
    return NextResponse.json({ ok: true, event: "ping" }, { status: 202 });
  }
  if (!SUPPORTED_EVENTS.has(eventType)) {
    await safeAudit(db, deliveryId, eventType, "succeeded");
    return NextResponse.json({ ok: true, ignored: true }, { status: 202 });
  }

  const event = normalizeGitHubWebhookEvent(eventType, payload);
  if (!event) {
    await safeAudit(db, deliveryId, eventType, "failed", "Webhook payload is missing required fields.");
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const result = await processGitHubWebhookEvent({ db, deliveryId, event });
  await safeAudit(
    db,
    deliveryId,
    eventType,
    result.failed > 0 ? "failed" : "succeeded",
    result.failed > 0 ? `${result.failed} matching trigger(s) failed.` : undefined,
  );
  return NextResponse.json(
    { ok: result.failed === 0, ...result },
    { status: result.failed > 0 ? 500 : 202 },
  );
}

async function safeAudit(
  db: ReturnType<typeof getDb>,
  deliveryId: string | null,
  eventType: string | null,
  status: "succeeded" | "failed" | "denied",
  error?: string,
): Promise<void> {
  try {
    await writeGitHubWebhookAudit({
      db,
      deliveryId,
      eventType,
      status,
      error,
    });
  } catch (auditError) {
    process.stderr.write(
      `[github-webhook-audit-error] ${JSON.stringify({
        deliveryId,
        eventType,
        message:
          auditError instanceof Error ? auditError.message : String(auditError),
      })}\n`,
    );
  }
}

function cleanHeader(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maxChars ? cleaned : null;
}
