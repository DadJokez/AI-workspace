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
  | {
      ok: true;
      attachments: PreparedChatAttachment[];
      resourceIds: string[];
    }
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

const FILE_REFERENCE_RE =
  /\b(?:upload(?:ed)?|attach(?:ed|ment)?|files?|documents?|docs?|pdfs?|spreadsheets?|sheets?|workbooks?|csvs?|decks?|slides?|presentations?|images?|photos?|screenshots?|datasets?|data)\b/i;
const FOLLOW_UP_REFERENCE_RE =
  /\b(?:it|this|that|these|those|them|same|above|prior|previous|earlier)\b/i;
const FILE_WORK_INTENT_RE =
  /\b(?:analy[sz]e|summari[sz]e|inspect|review|read|parse|extract|compare|calculate|chart|graph|visuali[sz]e|clean|transform|convert|edit|update|modify|change|audit|find|identify|show|explain|query|filter|sort|group|look|check)\b/i;
const DATA_QUESTION_RE =
  /\b(?:trends?|insights?|patterns?|anomal(?:y|ies)|outliers?|totals?|averages?|rows?|columns?|categories|regions?|revenue|sales|orders?|records?|duplicates?|correlations?|breakdowns?)\b/i;

/**
 * A stored upload is expensive context, so carry it only when the next turn
 * clearly asks to keep working with file/data content. The route separately
 * requires a prior upload in the same owned thread and no new attachment.
 */
export function shouldCarryForwardThreadUploads(message: string): boolean {
  const value = message.trim();
  if (!value) return false;

  const hasWorkIntent = FILE_WORK_INTENT_RE.test(value);
  const hasDataQuestion = DATA_QUESTION_RE.test(value);
  return (
    (hasWorkIntent &&
      (FILE_REFERENCE_RE.test(value) || FOLLOW_UP_REFERENCE_RE.test(value))) ||
    hasDataQuestion
  );
}

/**
 * Order comes from `metadata.uploadIndex` — the ordinal the upload path
 * stamps per file, and the ONLY record of request order (bulk insert
 * shares one createdAt; uuid tiebreak is random). Multi-file rows without
 * it (legacy uploads) fail closed: their original fold order is
 * unrecoverable, and replaying a reordered prompt would silently break the
 * byte-parity guarantee for order-sensitive requests.
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

  const indexed = rows.map((row) => ({
    row,
    uploadIndex: uploadIndexOf(row.metadata),
  }));
  let ordered: readonly StoredUploadArtifact[];
  if (indexed.every((entry) => entry.uploadIndex !== null)) {
    ordered = indexed
      .slice()
      .sort((left, right) => left.uploadIndex! - right.uploadIndex!)
      .map((entry) => entry.row);
  } else if (rows.length === 1) {
    ordered = rows;
  } else {
    return { ok: false, reason: "upload_order_unknown" };
  }

  const attachments: PreparedChatAttachment[] = [];
  for (const row of ordered) {
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

  return {
    ok: true,
    attachments,
    resourceIds: ordered.map((row) => row.id),
  };
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
  if (
    record.extractionStatus !== "extracted" &&
    record.extractionStatus !== "metadata_only"
  ) {
    return false;
  }
  if (RUNTIME_IMAGE_MIMES.has(mimeType)) {
    return record.storageEncoding === "base64";
  }
  return true;
}

function uploadIndexOf(metadata: unknown): number | null {
  const record = asRecord(metadata);
  const value = record?.uploadIndex;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Message-level replayability for the UI gate (#348): every upload must be
 * individually replayable AND multi-file turns must carry the ordinal that
 * makes their fold order deterministic.
 */
export function areUploadsReplayable(
  uploads: ReadonlyArray<{ mimeType: string | null; metadata: unknown }>,
): boolean {
  if (uploads.length === 0) return false;
  if (
    !uploads.every((upload) =>
      isReplayableUploadMetadata(upload.mimeType, upload.metadata),
    )
  ) {
    return false;
  }
  return (
    uploads.length === 1 ||
    uploads.every((upload) => uploadIndexOf(upload.metadata) !== null)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
