import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { selectEmptyStateSuggestions } from "@/lib/empty-state";
import { loadUserMcpProviderStatus } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
