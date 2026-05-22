import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb, userMemoryItems } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  normalizeMemoryCategory,
  serializeMemoryItem,
} from "@/lib/vault-memory";

export const dynamic = "force-dynamic";

const TITLE_MAX = 120;
const BODY_MAX = 2_000;

interface PatchBody {
  action?: "approve" | "edit" | "dismiss" | "archive";
  category?: string;
  title?: string;
  bodyMd?: string;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    if (
      body.action !== "approve" &&
      body.action !== "edit" &&
      body.action !== "dismiss" &&
      body.action !== "archive"
    ) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const patch = buildPatch(body, sessionUser.id);
    if ("error" in patch) {
      return NextResponse.json({ error: patch.error }, { status: 400 });
    }

    const db = getDb();
    const rows = await db
      .update(userMemoryItems)
      .set(patch.value)
      .where(
        and(eq(userMemoryItems.id, id), eq(userMemoryItems.userId, sessionUser.id)),
      )
      .returning();

    const item = rows[0];
    if (!item) {
      return NextResponse.json({ error: "memory_not_found" }, { status: 404 });
    }
    return NextResponse.json({ item: serializeMemoryItem(item) });
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

function buildPatch(body: PatchBody, userId: string) {
  const now = new Date();
  const editable = editablePatch(body);
  if ("error" in editable) return editable;

  if (body.action === "approve") {
    return {
      value: {
        ...editable.value,
        status: "approved" as const,
        approvedBy: userId,
        approvedAt: now,
        dismissedAt: null,
        archivedAt: null,
        updatedAt: now,
      },
    };
  }
  if (body.action === "edit") {
    if (Object.keys(editable.value).length === 0) {
      return { error: "nothing_to_update" as const };
    }
    return {
      value: {
        ...editable.value,
        updatedAt: now,
      },
    };
  }
  if (body.action === "dismiss") {
    return {
      value: {
        status: "dismissed" as const,
        dismissedAt: now,
        updatedAt: now,
      },
    };
  }
  return {
    value: {
      status: "archived" as const,
      archivedAt: now,
      updatedAt: now,
    },
  };
}

function editablePatch(body: PatchBody):
  | {
      value: {
        category?: string;
        title?: string;
        bodyMd?: string;
      };
    }
  | { error: "invalid_category" | "invalid_title" | "invalid_bodyMd" } {
  const value: { category?: string; title?: string; bodyMd?: string } = {};
  if (body.category !== undefined) {
    if (typeof body.category !== "string") return { error: "invalid_category" };
    value.category = normalizeMemoryCategory(body.category);
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return { error: "invalid_title" };
    const title = body.title.trim();
    if (!title || title.length > TITLE_MAX) return { error: "invalid_title" };
    value.title = title;
  }
  if (body.bodyMd !== undefined) {
    if (typeof body.bodyMd !== "string") return { error: "invalid_bodyMd" };
    const bodyMd = body.bodyMd.trim();
    if (!bodyMd || bodyMd.length > BODY_MAX) return { error: "invalid_bodyMd" };
    value.bodyMd = bodyMd;
  }
  return { value };
}
