/**
 * Steering text prepended to the first user message of a freshly-created
 * Cursor agent. The Cursor SDK has no system-prompt option on `Agent.create`,
 * so this is how we educate the model about who the user is, which tools
 * are available, and any custom instructions the user has set.
 *
 * Hidden from the user (prepended to the message text the SDK sees, not the
 * `chat_messages.content` we persist). Fires once per agent lifetime —
 * cloud agents retain context across subsequent turns.
 */

interface PreambleInput {
  user: {
    displayName: string;
    customInstructions: string | null;
  };
  /** Provider keys present in the turn's mcpServers map (e.g. ["github"]). */
  connectedProviders: readonly string[];
}

/**
 * One-line description of what each connected provider's MCP exposes.
 * Keep these short — they're the only signal the model sees about the
 * tool surface beyond the tools list itself.
 */
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  github:
    "GitHub: repositories, issues, pull requests, code search (pre-authorized, no token needed)",
  notion: "Notion: pages, databases, team docs (pre-authorized)",
  google:
    "Google Calendar: events, meetings, availability (pre-authorized)",
};

export function buildAgentPreamble({
  user,
  connectedProviders,
}: PreambleInput): string {
  const lines: string[] = [];
  lines.push(`You are an AI assistant for ${user.displayName}.`);
  lines.push("");

  if (connectedProviders.length > 0) {
    lines.push(
      "Connected tools — use these directly for any related requests:",
    );
    for (const p of connectedProviders) {
      lines.push(`- ${PROVIDER_DESCRIPTIONS[p] ?? p}`);
    }
  } else {
    lines.push(
      "No external tools are connected yet. The user can connect tools in the Tools section.",
    );
  }

  const ci = user.customInstructions?.trim();
  if (ci) {
    lines.push("");
    lines.push(`User instructions: ${ci}`);
  }

  lines.push("");
  lines.push(
    "Always prefer using connected tools over suggesting CLI commands, environment variables, or manual workarounds. If a tool call fails, surface the error clearly and try an alternative approach within the same tool suite.",
  );

  return lines.join("\n");
}
