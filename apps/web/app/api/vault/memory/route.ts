import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb, userMemoryItems } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { requireSession } from "@/lib/auth/requireSession";
import {
  ORG_INSTRUCTIONS_HEADING,
  buildVaultMarkdown,
  loadOrgMemoryItems,
  loadUserMemoryItems,
  normalizeMemoryCategory,
  serializeMemoryItem,
  type MemoryScope,
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
 *
 * `scope: "org"` (#438) writes an organization standing instruction: same
 * table, same immediate approval (the admin is the reviewer), gated by the
 * existing `requireAdmin`. It loads for every user's turns at org authority.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    let actor = session.user;

    let body: {
      title?: string;
      bodyMd?: string;
      category?: string;
      scope?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const scope = parseScope(body.scope);
    if (!scope) {
      return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
    }
    if (scope === "org") {
      const admin = await requireAdmin();
      if ("error" in admin) return admin.error;
      actor = admin.user;
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
        userId: actor.id,
        scope,
        status: "approved",
        category: normalizeMemoryCategory(
          body.category ?? (scope === "org" ? "organization" : "general"),
        ),
        title,
        bodyMd,
        confidence: 100,
        reason:
          scope === "org"
            ? "Admin added this organization standing instruction."
            : "User added this fact manually.",
        suggestedBy: scope === "org" ? "admin" : "user",
        approvedBy: actor.id,
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
    throw err;
  }
}

export async function GET() {
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const sessionUser = session.user;

    const db = getDb();
    const [items, orgItems] = await Promise.all([
      loadUserMemoryItems(db, sessionUser.id, ["approved", "suggested"]),
      // Everyone reads the approved org document; only admins may edit it.
      loadOrgMemoryItems(db, ["approved"]),
    ]);
    const approved = items.filter((item) => item.status === "approved");
    const suggestions = items.filter((item) => item.status === "suggested");

    return NextResponse.json({
      approvedMarkdown: buildVaultMarkdown(approved),
      approvedItems: approved.map(serializeMemoryItem),
      suggestions: suggestions.map(serializeMemoryItem),
      org: {
        approvedMarkdown: buildVaultMarkdown(orgItems, ORG_INSTRUCTIONS_HEADING),
        approvedItems: orgItems.map(serializeMemoryItem),
        canEdit: sessionUser.role === "admin",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}

function parseScope(value: unknown): MemoryScope | null {
  if (value === undefined || value === "user") return "user";
  if (value === "org") return "org";
  return null;
}
