import { chatThreads, type ChatThread, type Database } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { parseActivation, serializeActivation } from "@ai-workspace/agent";

/**
 * Thread-sticky tool-discovery activation (#384 P1), persisted in
 * `chat_threads.mcp_signature` — a column defined for exactly this shape
 * ("sorted provider names joined with ','") but never written until now,
 * which spares the substrate a schema migration.
 *
 * Activation is additive and sticky: providers are unioned in and never
 * removed mid-conversation — that stickiness is the tools-cache guarantee
 * the spec is built on. P1 activates every granted provider (parity with
 * today); P2 narrows new conversations to the core bundle and adds the
 * discovery tools that grow this set mid-thread.
 */
export async function ensureThreadActivation(
  db: Database,
  thread: Pick<ChatThread, "id" | "mcpSignature">,
  grantedProviders: readonly string[],
): Promise<string[]> {
  const current = parseActivation(thread.mcpSignature);
  const serialized = serializeActivation([...current, ...grantedProviders]);
  if (serialized !== serializeActivation(current)) {
    await db
      .update(chatThreads)
      .set({ mcpSignature: serialized, updatedAt: new Date() })
      .where(eq(chatThreads.id, thread.id));
  }
  return parseActivation(serialized);
}
