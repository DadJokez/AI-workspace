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
    vaultMarkdown?: string | null;
  };
  /** Provider keys present in the turn's mcpServers map (e.g. ["github"]). */
  connectedProviders: readonly string[];
  /** Connected provider keys withheld because this user has not approved them. */
  blockedProviders?: readonly string[];
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
  blockedProviders = [],
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

  if (blockedProviders.length > 0) {
    lines.push("");
    lines.push(
      "Connected tools blocked pending approval — do not claim you used these tools:",
    );
    for (const p of blockedProviders) {
      lines.push(`- ${p}`);
    }
    lines.push(
      'If the user asks for one of those tools, say exactly: "Tool access is connected but pending approval for this account."',
    );
  }

  const ci = user.customInstructions?.trim();
  if (ci) {
    lines.push("");
    lines.push(`User instructions: ${ci}`);
  }

  const vault = user.vaultMarkdown?.trim();
  if (vault) {
    lines.push("");
    lines.push("Personal context approved by the user:");
    lines.push(vault);
  }

  lines.push("");
  lines.push(
    "Always prefer using connected tools over suggesting CLI commands, environment variables, or manual workarounds. The connected tools support both reads AND writes (creating issues, opening pull requests, creating repositories, etc.) — call them directly when the user asks for those operations.",
  );
  lines.push("");
  lines.push(
    "Important artifact boundary: this is a deployed web app, not the user's local filesystem. If you create or edit files in the runtime workspace (for example paths under /app), those files are internal to the running container and are not directly accessible to the user unless the app explicitly exposes them. When the user asks you to make, create, write, generate, or edit a standalone file, you MUST return the complete finished file contents in a fenced code block with a filename in the fence info, for example ```markdown filename=\"notes.md\". The app saves that block as a clickable Workspace artifact. Do not merely say 'Written to `file.md`' or 'Saved as `file.html`' without the fenced file block; that will not expose the file to the user. Do not tell the user to copy/paste the file manually, do not add 'save this as a file' instructions, and do not repeat the whole artifact in prose after the fenced block.",
  );
  lines.push("");
  lines.push(
    "If a tool call returns an error, quote the exact error text from the tool's response back to the user verbatim. Do NOT paraphrase tool errors as 'MCP servers are down', 'tools are unavailable', 'I don't have access', or other infrastructure framing — the tool surface IS available; an individual call may have failed for a specific reason (validation, permissions, rate limits, name conflicts) and the user needs to see that exact reason. After surfacing the error, suggest a concrete next step: a corrected argument, a different tool, or a question for the user.",
  );

  return lines.join("\n");
}
