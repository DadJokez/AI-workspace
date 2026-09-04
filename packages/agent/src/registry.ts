import type { Tool } from "./types";

/**
 * Holds tool definitions and resolves them by name. Each tool has a unique
 * name; registering twice is an error. Every tool carries a runtime policy
 * (#701); the loop fails closed to needs-approval if one slips through.
 *
 * In v1 the registry is in-process (one per app instance, populated at boot).
 * Same shape will work for an out-of-process MCP-backed registry later.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List tools, optionally filtered to an allow-list.
   * Returns tools in the order names appear in `allowed` if provided,
   * else in registration order.
   */
  list(allowed?: readonly string[]): Tool[] {
    if (!allowed) return Array.from(this.tools.values());
    const out: Tool[] = [];
    for (const name of allowed) {
      const t = this.tools.get(name);
      if (t) out.push(t);
    }
    return out;
  }

  size(): number {
    return this.tools.size;
  }

  /**
   * Convert to the shape Bedrock's `converse` API expects under
   * `toolConfig.tools`. Keep this as the single seam — if Bedrock's tool
   * config shape changes, only this method moves.
   */
  toBedrockToolConfig(allowed?: readonly string[]): BedrockToolConfig {
    const tools = this.list(allowed).map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: normalizeToolInputSchema(t.inputSchema) },
      },
    }));
    return { tools };
  }
}

export function normalizeToolInputSchema(
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const normalized = { ...(schema as Record<string, unknown>) };
  if (normalized.type !== "object") normalized.type = "object";
  if (
    !normalized.properties ||
    typeof normalized.properties !== "object" ||
    Array.isArray(normalized.properties)
  ) {
    normalized.properties = {};
  }
  return normalized;
}

export interface BedrockToolConfig {
  tools: Array<{
    toolSpec: {
      name: string;
      description: string;
      inputSchema: { json: Record<string, unknown> };
    };
  }>;
  /** Force the first model step to request one specific registered tool. */
  toolChoice?: { tool: { name: string } };
}
