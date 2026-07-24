import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { selectEmptyStateSuggestions } from "@/lib/empty-state";
import { loadUserMcpProviderStatus } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const db = getDb();
  const [profileRows, providerStatus] = await Promise.all([
    db
      .select({ customInstructions: users.customInstructions })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1),
    loadUserMcpProviderStatus(db, sessionUser.id),
  ]);
  const profile = profileRows[0];
  if (!profile) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    suggestions: selectEmptyStateSuggestions({
      roleContext: profile.customInstructions,
      availableProviders: providerStatus.allowedProviders,
    }),
    connectedProviders: providerStatus.connectedProviders,
  });
}
