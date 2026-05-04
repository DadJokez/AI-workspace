import {
  AuthConfigError,
  UnauthorizedError,
  getCurrentUser,
} from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser(req);
    if (!authUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const dbUser = await ensureUser(authUser);
    const db = getDb();

    const rows = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        defaultModelId: chatThreads.defaultModelId,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .where(eq(chatThreads.userId, dbUser.id))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(100);

    return NextResponse.json({ threads: rows });
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
