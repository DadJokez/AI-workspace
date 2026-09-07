import { providerSupportsViewerIdentity } from "@/lib/app-binding-providers";
import type { ToolCall, ToolResult } from "@ai-workspace/agent";
import { parseDataBindings, type DataBinding } from "@/lib/app-data-bindings";

export function connectedDataProviders(calls: readonly ToolCall[] = [], results: readonly ToolResult[] = []): string[] {
  const succeeded = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
  return [...new Set(calls.filter((call) => succeeded.has(call.id))
    .map((call) => call.name.split("__", 1)[0] ?? "")
    .filter(providerSupportsViewerIdentity))];
}

export interface ConnectedDataWarning {
  kind: "possible_embedded_connected_data";
  providers: string[];
}

/** Only pass the matched prior version, never another file's or thread's metadata. */
export function artifactDataMetadata(html: string, bindings: readonly DataBinding[], providers: readonly string[], priorMetadata?: unknown): Record<string, unknown> {
  const effectiveBindings = bindings.length ? bindings : parseDataBindings(priorMetadata);
  const priorWarning = readConnectedDataWarning(priorMetadata);
  return {
    ...(effectiveBindings.length ? { dataBindings: effectiveBindings } : {}),
    connectedDataWarning: detectEmbeddedConnectedData(html, [
      ...providers, ...effectiveBindings.map((binding) => binding.provider), ...(priorWarning?.providers ?? []),
    ]),
  };
}

/** A warning, not a proof of safety: large script data can also be legitimate UI data. */
export function detectEmbeddedConnectedData(html: string, providers: readonly string[]): ConnectedDataWarning | null {
  const recognized = [...new Set(providers.filter(providerSupportsViewerIdentity))];
  if (!recognized.length) return null;
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const largeInlineData = scripts.some((match) => {
    const source = match[1] ?? "";
    return source.length >= 500 && (source.match(/(?:"[^"\n]{1,80}"|'[^'\n]{1,80}'|\b\w+)\s*:/g)?.length ?? 0) >= 8;
  });
  return largeInlineData ? { kind: "possible_embedded_connected_data", providers: recognized } : null;
}

export function readConnectedDataWarning(metadata: unknown): ConnectedDataWarning | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).connectedDataWarning;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "possible_embedded_connected_data" || !Array.isArray(record.providers)) return null;
  const providers = record.providers.filter((p): p is string => typeof p === "string" && providerSupportsViewerIdentity(p));
  return providers.length ? { kind: "possible_embedded_connected_data", providers: [...new Set(providers)] } : null;
}
