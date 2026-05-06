import {
  AuthConfigError,
  UnauthorizedError,
  requireUser,
} from "@ai-workspace/auth";
import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

interface PatchBody {
  displayName?: string;
  customInstructions?: string | null;
}

const DISPLAY_NAME_MAX = 80;
const CUSTOM_INSTRUCTIONS_MAX = 4000;

function profileFromRow(row: {
  id: string;
  email: string;
  displayName: string;
  customInstructions: string | null;
}) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    customInstructions: row.customInstructions,
  };
}

async function authOrError(req: Request) {
  try {
    return { user: await requireUser(req) } as const;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
    }
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

export async function GET(req: Request) {
  const auth = await authOrError(req);
  if ("error" in auth) return auth.error;
  const dbUser = await ensureUser(auth.user);
  return NextResponse.json({ user: profileFromRow(dbUser) });
}

export async function PATCH(req: Request) {
  const auth = await authOrError(req);
  if ("error" in auth) return auth.error;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: { displayName?: string; customInstructions?: string | null } = {};

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

  const dbUser = await ensureUser(auth.user);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ user: profileFromRow(dbUser) });
  }

  const db = getDb();
  const updated = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, dbUser.id))
    .returning();
  return NextResponse.json({ user: profileFromRow(updated[0]!) });
}
