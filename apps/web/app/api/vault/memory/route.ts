import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  buildVaultMarkdown,
  loadUserMemoryItems,
  serializeMemoryItem,
} from "@/lib/vault-memory";

export const dynamic = "force-dynamic";

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
