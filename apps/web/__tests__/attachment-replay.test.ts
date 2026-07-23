import { describe, expect, it } from "vitest";
import {
  areUploadsReplayable,
  isReplayableUploadMetadata,
  reconstructStoredAttachments,
  shouldCarryForwardThreadUploads,
  type StoredUploadArtifact,
} from "@/lib/attachment-replay";
import { foldAttachmentsIntoPrompt } from "@/lib/attachments";

function docRow(overrides: Partial<StoredUploadArtifact> = {}): StoredUploadArtifact {
  return {
    id: "artifact-doc",
    title: "notes.pdf",
    filename: "notes.pdf",
    kind: "document",
    mimeType: "application/pdf",
    content: "cGRmLWJ5dGVz",
    sizeBytes: 9,
    metadata: {
      uploadIndex: 0,
      storageEncoding: "base64",
      extractionStatus: "extracted",
      extractedText: "Quarterly numbers: 42.",
    },
    ...overrides,
  };
}

function imageRow(overrides: Partial<StoredUploadArtifact> = {}): StoredUploadArtifact {
  return {
    id: "artifact-img",
    title: "chart.png",
    filename: "chart.png",
    kind: "image",
    mimeType: "image/png",
    content: "aW1hZ2UtYnl0ZXM=",
    sizeBytes: 11,
    metadata: {
      uploadIndex: 1,
      storageEncoding: "base64",
      extractionStatus: "metadata_only",
      extractedText: "PNG image, 640x480.",
      image: { width: 640, height: 480 },
    },
    ...overrides,
  };
}

describe("reconstructStoredAttachments", () => {
  it("rebuilds a document's folded text and an image's native block", () => {
    const result = reconstructStoredAttachments([docRow(), imageRow()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [doc, image] = result.attachments;
    expect(doc).toMatchObject({
      name: "notes.pdf",
      kind: "document",
      content: "Quarterly numbers: 42.",
      storageContent: "cGRmLWJ5dGVz",
      storageEncoding: "base64",
      extractionStatus: "extracted",
    });
    expect(doc?.runtimeContent).toBeUndefined();
    expect(image?.runtimeContent).toEqual({
      type: "image",
      mimeType: "image/png",
      dataBase64: "aW1hZ2UtYnl0ZXM=",
    });
    expect(image?.image).toEqual({ width: 640, height: 480 });

    // The replayed fold must match what a fresh upload would produce.
    const folded = foldAttachmentsIntoPrompt("edited text", result.attachments);
    expect(folded).toContain("edited text");
    expect(folded).toContain("Quarterly numbers: 42.");
  });

  it("re-sorts scrambled rows by uploadIndex so the fold matches request order", () => {
    // Bulk insert shares one createdAt and the uuid tiebreak is random —
    // the DB can hand rows back in any order. The ordinal must win.
    const result = reconstructStoredAttachments([imageRow(), docRow()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments.map((a) => a.name)).toEqual([
      "notes.pdf",
      "chart.png",
    ]);
    expect(result.resourceIds).toEqual(["artifact-doc", "artifact-img"]);
  });

  it("fails closed on multi-file turns whose upload order is unrecorded", () => {
    const legacyDoc = docRow({
      metadata: {
        storageEncoding: "base64",
        extractionStatus: "extracted",
        extractedText: "Quarterly numbers: 42.",
      },
    });
    const legacyImage = imageRow({
      id: "artifact-img-legacy",
      metadata: {
        storageEncoding: "base64",
        extractionStatus: "metadata_only",
        extractedText: "PNG image.",
      },
    });
    expect(reconstructStoredAttachments([legacyDoc, legacyImage])).toEqual({
      ok: false,
      reason: "upload_order_unknown",
    });
    // A single legacy upload has a trivial order — still replayable.
    expect(reconstructStoredAttachments([legacyDoc]).ok).toBe(true);
  });

  it("fails closed when the extracted text is missing", () => {
    const row = docRow({
      metadata: { storageEncoding: "base64", extractionStatus: "extracted" },
    });
    expect(reconstructStoredAttachments([row])).toEqual({
      ok: false,
      reason: "incomplete_upload_row:artifact-doc",
    });
  });

  it("fails closed when an image's bytes are not base64", () => {
    const row = imageRow({
      metadata: {
        storageEncoding: "utf8",
        extractionStatus: "metadata_only",
        extractedText: "PNG image.",
      },
    });
    expect(reconstructStoredAttachments([row])).toEqual({
      ok: false,
      reason: "image_bytes_unavailable:artifact-img",
    });
  });

  it("fails closed on empty input and on more rows than the upload cap", () => {
    expect(reconstructStoredAttachments([]).ok).toBe(false);
    const rows = Array.from({ length: 6 }, (_row, index) =>
      docRow({ id: `artifact-${index}` }),
    );
    expect(reconstructStoredAttachments(rows)).toEqual({
      ok: false,
      reason: "too_many_stored_uploads",
    });
  });

  it("fails closed on malformed metadata rather than guessing", () => {
    expect(reconstructStoredAttachments([docRow({ metadata: null })]).ok).toBe(
      false,
    );
    expect(
      reconstructStoredAttachments([docRow({ mimeType: null })]).ok,
    ).toBe(false);
    expect(
      reconstructStoredAttachments([
        docRow({ kind: "mystery" as StoredUploadArtifact["kind"] }),
      ]).ok,
    ).toBe(false);
  });
});

describe("shouldCarryForwardThreadUploads", () => {
  it.each([
    "Analyze it. Look for trends, insights, patterns, anything interesting.",
    "Summarize the uploaded file",
    "Review this spreadsheet for anomalies",
    "What are the top regions by revenue?",
    "Chart the sales breakdown",
    "Compare these documents",
  ])("carries prior uploads for file-work follow-up: %s", (message) => {
    expect(shouldCarryForwardThreadUploads(message)).toBe(true);
  });

  it.each([
    "Thanks!",
    "What should we work on next?",
    "Tell me a joke",
    "How are you?",
    "Open my GitHub issues",
  ])("does not mount large uploads for unrelated chat: %s", (message) => {
    expect(shouldCarryForwardThreadUploads(message)).toBe(false);
  });
});

describe("areUploadsReplayable", () => {
  const withIndex = (uploadIndex: number) => ({
    mimeType: "application/pdf",
    metadata: {
      uploadIndex,
      storageEncoding: "base64",
      extractionStatus: "extracted",
      extractedText: "text",
    },
  });
  const legacy = {
    mimeType: "application/pdf",
    metadata: {
      storageEncoding: "base64",
      extractionStatus: "extracted",
      extractedText: "text",
    },
  };

  it("requires ordinals for multi-file turns but not single files", () => {
    expect(areUploadsReplayable([withIndex(0), withIndex(1)])).toBe(true);
    expect(areUploadsReplayable([legacy])).toBe(true);
    expect(areUploadsReplayable([withIndex(0), legacy])).toBe(false);
    expect(areUploadsReplayable([])).toBe(false);
  });
});

describe("isReplayableUploadMetadata", () => {
  it("mirrors the server requirements for the UI gate", () => {
    expect(
      isReplayableUploadMetadata("application/pdf", {
        storageEncoding: "base64",
        extractionStatus: "extracted",
        extractedText: "text",
      }),
    ).toBe(true);
    expect(
      isReplayableUploadMetadata("image/png", {
        storageEncoding: "base64",
        extractionStatus: "metadata_only",
        extractedText: "img",
      }),
    ).toBe(true);
    // Image without original bytes in base64 → not replayable.
    expect(
      isReplayableUploadMetadata("image/png", {
        storageEncoding: "utf8",
        extractionStatus: "metadata_only",
        extractedText: "img",
      }),
    ).toBe(false);
    // The client mirrors the server's extractionStatus requirement so the
    // pencil never leads to a guaranteed 409 (review minor on #405).
    expect(
      isReplayableUploadMetadata("application/pdf", {
        storageEncoding: "base64",
        extractedText: "text",
      }),
    ).toBe(false);
    expect(isReplayableUploadMetadata("application/pdf", {})).toBe(false);
    expect(isReplayableUploadMetadata(null, { extractedText: "x" })).toBe(
      false,
    );
  });
});
