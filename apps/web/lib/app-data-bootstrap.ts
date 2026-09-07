import type { ToolCall, ToolResult } from "@ai-workspace/agent";
import {
  LEGACY_SOQL_PROVIDER,
  LEGACY_SOQL_TOOL_NAME,
  MAX_DATA_BINDINGS,
  type DataBinding,
} from "@/lib/app-data-bindings";
import { validateReadOnlySoql } from "@/lib/salesforce/api";
export { buildAppDataBootstrap, injectAppDataBootstrap } from "@/lib/app-data-client-bootstrap";

/**
 * Live-data app client wiring (#407, second half). Server-only:
 * - derive pinned bindings from the run_soql calls a minting turn actually
 *   ran (authoring auto-emit — "share as live app" without asking), and
 * - inject the in-page bootstrap that lets a served app call its own data
 *   endpoint under the viewer's session.
 */

const RUN_SOQL_TOOL = "salesforce__run_soql";

/**
 * Bindings for a servable artifact, derived from the minting turn's
 * successful run_soql calls. Failed calls are skipped (their query returned
 * nothing the page could have rendered), duplicates collapse to the first
 * occurrence, every query must still pass read-only validation, and the
 * list caps at MAX_DATA_BINDINGS in call order.
 */
export function deriveBindingsFromTurnTools(
  toolCalls: readonly ToolCall[] | undefined,
  toolResults: readonly ToolResult[] | undefined,
): DataBinding[] {
  if (!toolCalls?.length) return [];
  const failed = new Set(
    (toolResults ?? [])
      .filter((result) => result.isError)
      .map((result) => result.toolCallId),
  );
  const bindings: DataBinding[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== RUN_SOQL_TOOL) continue;
    if (failed.has(call.id)) continue;
    const soql = (call.input as { soql?: unknown })?.soql;
    if (typeof soql !== "string") continue;
    let query: string;
    try {
      query = validateReadOnlySoql(soql);
    } catch {
      continue;
    }
    if (seen.has(query)) continue;
    seen.add(query);
    // Emitted on the generic #802 shape; ids keep the `soql-N` contract the
    // run_soql usage notes promise page authors.
    bindings.push({
      id: `soql-${bindings.length + 1}`,
      provider: LEGACY_SOQL_PROVIDER,
      toolName: LEGACY_SOQL_TOOL_NAME,
      pinnedArgs: { soql: query },
    });
    if (bindings.length >= MAX_DATA_BINDINGS) break;
  }
  return bindings;
}
