import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb, userMemoryItems } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  buildVaultMarkdown,
  loadUserMemoryItems,
  normalizeMemoryCategory,
  serializeMemoryItem,
} from "@/lib/vault-memory";

export const dynamic = "force-dynamic";

const TITLE_MAX = 120;
const BODY_MAX = 2_000;

/**
 * Manually add a memory fact (parity P1.3). Unlike captured suggestions, a
 * user-added fact lands `approved` immediately — the user is the author, so
 * there's nothing to review. It injects into future turns like any approved
 * item. Closes the "add manual facts" gap and complements the onboarding
 * wizard's seeded role context.
 */
export async function POST(req: Request) {
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: { title?: string; bodyMd?: string; category?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const bodyMd = typeof body.bodyMd === "string" ? body.bodyMd.trim() : "";
    if (!title || title.length > TITLE_MAX) {
      return NextResponse.json(
        {
          error: "invalid_title",
          message: `Give it a short title (≤ ${TITLE_MAX} chars).`,
        },
        { status: 400 },
      );
    }
    if (!bodyMd || bodyMd.length > BODY_MAX) {
      return NextResponse.json(
        {
          error: "invalid_body",
          message: `The fact is required and must be ≤ ${BODY_MAX} chars.`,
        },
        { status: 400 },
      );
    }

    const db = getDb();
    const now = new Date();
    const rows = await db
      .insert(userMemoryItems)
      .values({
        userId: sessionUser.id,
        status: "approved",
        category: normalizeMemoryCategory(body.category ?? "general"),
        title,
        bodyMd,
        confidence: 100,
        reason: "User added this fact manually.",
        suggestedBy: "user",
        approvedBy: sessionUser.id,
        approvedAt: now,
      })
      .returning();

    return NextResponse.json(
      { item: serializeMemoryItem(rows[0]!) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}

export async function GET() {
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const db = getDb();
    const items = await loadUserMemoryItems(db, sessionUser.id, [
      "approved",
      "suggested",
    ]);
    const approved = items.filter((item) => item.status === "approved");
    const suggestions = items.filter((item) => item.status === "suggested");

    return NextResponse.json({
      approvedMarkdown: buildVaultMarkdown(approved),
      approvedItems: approved.map(serializeMemoryItem),
      suggestions: suggestions.map(serializeMemoryItem),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}
