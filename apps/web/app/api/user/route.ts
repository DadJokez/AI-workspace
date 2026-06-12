import { AuthConfigError } from "@ai-workspace/auth";
import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

interface PatchBody {
  displayName?: string;
  customInstructions?: string | null;
  defaultModelId?: string | null;
  /** True marks the first-run welcome tour finished (or skipped). */
  tourCompleted?: boolean;
}

const DISPLAY_NAME_MAX = 80;
const CUSTOM_INSTRUCTIONS_MAX = 4000;
const DEFAULT_MODEL_ID_MAX = 120;

function profileFromRow(row: {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  customInstructions: string | null;
  defaultModelId: string | null;
  tourCompletedAt: Date | null;
}) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    customInstructions: row.customInstructions,
    defaultModelId: row.defaultModelId,
    tourCompletedAt: row.tourCompletedAt
      ? row.tourCompletedAt.toISOString()
      : null,
  };
}

async function authOrError() {
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return {
        error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      } as const;
    }
    return { sessionUser } as const;
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return {
        error: NextResponse.json(
          { error: "auth_config_error", message: err.message },
          { status: 500 },
        ),
      } as const;
    }
    throw err;
  }
}

export async function GET() {
  const auth = await authOrError();
  if ("error" in auth) return auth.error;

  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, auth.sessionUser.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ user: profileFromRow(row) });
}

export async function PATCH(req: Request) {
  const auth = await authOrError();
  if ("error" in auth) return auth.error;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: {
    displayName?: string;
    customInstructions?: string | null;
    defaultModelId?: string | null;
    tourCompletedAt?: Date;
  } = {};

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      return NextResponse.json(
        { error: "invalid_displayName" },
        { status: 400 },
      );
    }
    const trimmed = body.displayName.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: "displayName_required" },
        { status: 400 },
      );
    }
    if (trimmed.length > DISPLAY_NAME_MAX) {
      return NextResponse.json(
        { error: "displayName_too_long" },
        { status: 400 },
      );
    }
    patch.displayName = trimmed;
  }

  if (body.customInstructions !== undefined) {
    if (body.customInstructions === null) {
      patch.customInstructions = null;
    } else if (typeof body.customInstructions !== "string") {
      return NextResponse.json(
        { error: "invalid_customInstructions" },
        { status: 400 },
      );
    } else {
      const trimmed = body.customInstructions.trim();
      if (trimmed.length > CUSTOM_INSTRUCTIONS_MAX) {
        return NextResponse.json(
          { error: "customInstructions_too_long" },
          { status: 400 },
        );
      }
      patch.customInstructions = trimmed.length > 0 ? trimmed : null;
    }
  }

  if (body.defaultModelId !== undefined) {
    if (body.defaultModelId === null) {
      patch.defaultModelId = null;
    } else if (typeof body.defaultModelId !== "string") {
      return NextResponse.json(
        { error: "invalid_defaultModelId" },
        { status: 400 },
      );
    } else {
      const trimmed = body.defaultModelId.trim();
      if (trimmed.length === 0) {
        patch.defaultModelId = null;
      } else if (trimmed.length > DEFAULT_MODEL_ID_MAX) {
        return NextResponse.json(
          { error: "defaultModelId_too_long" },
          { status: 400 },
        );
      } else {
        patch.defaultModelId = trimmed;
      }
    }
  }

  if (body.tourCompleted !== undefined) {
    if (body.tourCompleted !== true) {
      return NextResponse.json(
        { error: "invalid_tourCompleted" },
        { status: 400 },
      );
    }
    patch.tourCompletedAt = new Date();
  }

  const db = getDb();

  if (Object.keys(patch).length === 0) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, auth.sessionUser.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ user: profileFromRow(row) });
  }

  const updated = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, auth.sessionUser.id))
    .returning();
  const row = updated[0];
  if (!row) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ user: profileFromRow(row) });
}
