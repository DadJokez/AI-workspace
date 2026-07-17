import {
  MAX_ATTACHMENTS,
  type PreparedChatAttachment,
} from "@/lib/attachments";

/**
 * Edit-and-resend for file-bearing turns (#348): rebuild the runtime
 * attachment payload from the target user message's stored `user-upload`
 * workspace artifacts, so an edited prompt replays with the original file
 * context and no re-upload.
 *
 * Fidelity comes from what the fresh-upload path persisted: the original
 * bytes in `content` (`metadata.storageEncoding` says how) and the exact
 * prompt-folded text in `metadata.extractedText`. Reconstruction FAILS
 * CLOSED — any row missing what the original turn carried keeps the
 * follow-up-only behavior rather than silently replaying a degraded
 * payload.
 */

/** The columns + metadata a stored user-upload row must supply. */
export interface StoredUploadArtifact {
  id: string;
  title: string | null;
  filename: string | null;
  kind: string;
  mimeType: string | null;
  content: string;
  sizeBytes: number | null;
  metadata: unknown;
}

export type AttachmentReplayResult =
  | { ok: true; attachments: PreparedChatAttachment[] }
  | { ok: false; reason: string };

const ATTACHMENT_KINDS = new Set([
  "text",
  "document",
  "spreadsheet",
  "presentation",
  "image",
]);

const RUNTIME_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * Rows must be passed in original upload order (createdAt, then id) so the
 * replayed fold matches the original turn byte-for-byte.
 */
export function reconstructStoredAttachments(
  rows: readonly StoredUploadArtifact[],
): AttachmentReplayResult {
  if (rows.length === 0) {
    return { ok: false, reason: "no_stored_uploads" };
  }
  if (rows.length > MAX_ATTACHMENTS) {
    return { ok: false, reason: "too_many_stored_uploads" };
  }

  const attachments: PreparedChatAttachment[] = [];
  for (const row of rows) {
    const name = row.filename ?? row.title;
    const metadata = asRecord(row.metadata);
    if (!name || !row.mimeType || !metadata) {
      return { ok: false, reason: `incomplete_upload_row:${row.id}` };
    }
    const storageEncoding = metadata.storageEncoding;
    const extractionStatus = metadata.extractionStatus;
    const extractedText = metadata.extractedText;
    if (
      (storageEncoding !== "utf8" && storageEncoding !== "base64") ||
      (extractionStatus !== "extracted" &&
        extractionStatus !== "metadata_only") ||
      typeof extractedText !== "string" ||
      !ATTACHMENT_KINDS.has(row.kind)
    ) {
      return { ok: false, reason: `incomplete_upload_row:${row.id}` };
    }

    let runtimeContent: PreparedChatAttachment["runtimeContent"];
    if (RUNTIME_IMAGE_MIMES.has(row.mimeType)) {
      // The original turn sent a native image block; replay must too.
      if (storageEncoding !== "base64" || row.content.length === 0) {
        return { ok: false, reason: `image_bytes_unavailable:${row.id}` };
      }
      runtimeContent = {
        type: "image",
        mimeType: row.mimeType as "image/png" | "image/jpeg" | "image/webp",
        dataBase64: row.content,
      };
    }

    const extractionNotes = Array.isArray(metadata.extractionNotes)
      ? metadata.extractionNotes.filter(
          (note): note is string => typeof note === "string",
        )
      : undefined;
    const image = asRecord(metadata.image);

    attachments.push({
      name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes ?? row.content.length,
      kind: row.kind as PreparedChatAttachment["kind"],
      content: extractedText,
      storageContent: row.content,
      storageEncoding,
      extractionStatus,
      ...(extractionNotes?.length ? { extractionNotes } : {}),
      ...(image
        ? {
            image: {
              ...(typeof image.width === "number"
                ? { width: image.width }
                : {}),
              ...(typeof image.height === "number"
                ? { height: image.height }
                : {}),
            },
          }
        : {}),
      ...(runtimeContent ? { runtimeContent } : {}),
    });
  }

  return { ok: true, attachments };
}

/**
 * Client-side mirror of the reconstruction requirements, computed from a
 * serialized artifact's public fields. Used only to decide whether to SHOW
 * the edit control — the server-side reconstruction remains the authority
 * and fails closed on anything this approximation gets wrong.
 */
export function isReplayableUploadMetadata(
  mimeType: string | null | undefined,
  metadata: unknown,
): boolean {
  const record = asRecord(metadata);
  if (!record || !mimeType) return false;
  if (typeof record.extractedText !== "string") return false;
  if (
    record.storageEncoding !== "utf8" &&
    record.storageEncoding !== "base64"
  ) {
    return false;
  }
  if (RUNTIME_IMAGE_MIMES.has(mimeType)) {
    return record.storageEncoding === "base64";
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
