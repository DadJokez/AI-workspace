import { chatThreads, type ChatThread, type Database } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import {
  parseActivation,
  serializeActivation,
  type AgentEvent,
} from "@ai-workspace/agent";

const ACTIVATE_TOOL_NAME = "comparative__activate_tools";

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

/**
 * Sticky-activation persistence (#384 P2): the single trigger, shared by
 * both runtime lanes, for turning a `comparative__activate_tools` tool-call
 * in the event stream into a persisted thread activation.
 *
 * Ignores everything but activate tool-calls for granted providers.
 * Threads `currentSignature` through so a second same-turn activation
 * unions against the just-written set, not a stale snapshot, and returns
 * the next signature. Best-effort by design: within-turn mounting never
 * depends on the persisted value, so a failing db is swallowed and the run
 * proceeds (next turn re-derives from granted state). Note: this rewrites
 * `mcp_signature` from the granted-filtered signature, so a since-revoked
 * provider that `buildTurnToolDiscovery` keeps sticky can be dropped —
 * benign, since revoked providers never mount.
 */
export async function persistActivationFromEvent({
  db,
  threadId,
  grantedProviders,
  event,
  currentSignature,
}: {
  db: Database;
  threadId: string;
  grantedProviders: readonly string[];
  event: AgentEvent;
  currentSignature: string;
}): Promise<string> {
  if (event.type !== "tool-call" || event.call.name !== ACTIVATE_TOOL_NAME) {
    return currentSignature;
  }
  const raw = (event.call.input as { provider?: unknown })?.provider;
  if (typeof raw !== "string") return currentSignature;
  const provider = raw.trim().toLowerCase();
  if (!grantedProviders.includes(provider)) return currentSignature;
  try {
    const activated = await ensureThreadActivation(
      db,
      { id: threadId, mcpSignature: currentSignature },
      [provider],
    );
    return serializeActivation(activated);
  } catch {
    return currentSignature;
  }
}
