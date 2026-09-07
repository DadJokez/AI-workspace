import { mcpToolName, providerOfToolName, type ToolCall, type ToolResult } from "@ai-workspace/agent";
import { toolsCatalog, type Database } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { providerSupportsViewerIdentity } from "@/lib/app-binding-providers";
import { MAX_DATA_BINDINGS, parseDataBindings, type DataBinding } from "@/lib/app-data-bindings";
import { deriveBindingsFromTurnTools } from "@/lib/app-data-bootstrap";

/** Metadata only: publication and every refresh still enforce the viewer's policy. */
export async function deriveAuthoringBindings(
  db: Database,
  calls: readonly ToolCall[] = [],
  results: readonly ToolResult[] = [],
): Promise<DataBinding[]> {
  const bindings = deriveBindingsFromTurnTools(calls, results);
  const succeeded = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
  const failed = new Set(results.filter((result) => result.isError).map((result) => result.toolCallId));
  const candidates = calls.filter((call) => succeeded.has(call.id) && !failed.has(call.id) && call.name !== "salesforce__run_soql" && providerSupportsViewerIdentity(providerOfToolName(call.name) ?? ""));
  if (!candidates.length || bindings.length === MAX_DATA_BINDINGS) return bindings;
  const catalog = await db.select({ provider: toolsCatalog.provider, toolName: toolsCatalog.toolName })
    .from(toolsCatalog)
    .where(and(eq(toolsCatalog.enabled, true), eq(toolsCatalog.action, "read"), eq(toolsCatalog.policy, "always_allow")));
  const seen = new Set<string>();
  for (const call of candidates) {
    // Match the runtime's name encoder, including truncation; ambiguous names are not bindable.
    const matches = catalog.filter((entry) => providerSupportsViewerIdentity(entry.provider) && mcpToolName(entry.provider, entry.toolName) === call.name);
    if (matches.length !== 1) continue;
    const entry = matches[0]!;
    const [binding] = parseDataBindings({ dataBindings: [{
      id: `data-${bindings.length + 1}`, ...entry, pinnedArgs: call.input,
    }] });
    if (!binding) continue;
    const key = JSON.stringify([binding.provider, binding.toolName, binding.pinnedArgs]);
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
    if (bindings.length === MAX_DATA_BINDINGS) break;
  }
  return bindings;
}
