import { findCredentialShapedContent } from "@/lib/secret-scan";

/**
 * File attachments for chat (parity P1.1 — the #1 shadow-tool plug). v1
 * handles text-extractable documents: the client reads them as text, the
 * route folds the text into the model prompt (so the assistant sees the file)
 * while the chat bubble shows only the user's typed message, and each file is
 * stored as a workspace artifact so it renders as a chip on the turn.
 *
 * Images/PDF vision are a follow-up (they need multimodal content blocks
 * through the runtime seam).
 */

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_CHARS = 200_000; // ~50k tokens — one big doc
export const MAX_TOTAL_ATTACHMENT_CHARS = 400_000;

/** Extensions the client can read as text today. */
export const SUPPORTED_TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "log",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "cs",
  "sh",
  "sql",
  "css",
  "tf",
  "ini",
  "toml",
  "env",
] as const;

export interface ChatAttachment {
  name: string;
  content: string;
}

export function isSupportedAttachmentName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (SUPPORTED_TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

export interface AttachmentValidation {
  ok: boolean;
  error?: string;
  attachments: ChatAttachment[];
}

/**
 * Validate and normalize an incoming attachments array (server-side trust
 * boundary). Caps count, per-file size, and total size; drops empties.
 */
export function validateAttachments(raw: unknown): AttachmentValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "attachments must be an array", attachments: [] };
  }
  if (raw.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: `At most ${MAX_ATTACHMENTS} files per message.`,
      attachments: [],
    };
  }

  const attachments: ChatAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { name?: unknown }).name !== "string" ||
      typeof (item as { content?: unknown }).content !== "string"
    ) {
      return { ok: false, error: "invalid attachment shape", attachments: [] };
    }
    const name = (item as ChatAttachment).name.slice(0, 200);
    const content = (item as ChatAttachment).content;
    if (!content.trim()) continue; // skip empties silently
    if (content.length > MAX_ATTACHMENT_CHARS) {
      return {
        ok: false,
        error: `"${name}" is too large (max ${Math.round(MAX_ATTACHMENT_CHARS / 1000)}k characters).`,
        attachments: [],
      };
    }
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_CHARS) {
      return {
        ok: false,
        error: "Attachments are too large in total — remove one and retry.",
        attachments: [],
      };
    }
    attachments.push({ name, content });
  }

  return { ok: true, attachments };
}

/**
 * Fold attachment text into the model prompt. The typed message stays the
 * user-visible bubble; this composed string is what the runtime sees.
 */
export function foldAttachmentsIntoPrompt(
  message: string,
  attachments: readonly ChatAttachment[],
): string {
  if (attachments.length === 0) return message;
  const blocks = attachments.map((a) => {
    const fence = a.content.includes("```") ? "````" : "```";
    return `Attached file: ${a.name}\n${fence}\n${a.content}\n${fence}`;
  });
  return [
    message,
    "",
    "--- Attached files (the user uploaded these for this turn) ---",
    ...blocks,
  ].join("\n");
}

/**
 * No-secrets check at the trust boundary: reuse the app no-secrets scanner so
 * a credential-shaped string in an uploaded file is flagged before it is
 * stored or sent. Returns human-readable findings; empty = clean.
 */
export function scanAttachmentsForSecrets(
  attachments: readonly ChatAttachment[],
): string[] {
  const findings = new Set<string>();
  for (const a of attachments) {
    for (const f of findCredentialShapedContent(a.content)) {
      findings.add(`${a.name}: ${f}`);
    }
  }
  return [...findings];
}
