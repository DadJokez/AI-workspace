import { describe, expect, it } from "vitest";
import {
  isReplayableUploadMetadata,
  reconstructStoredAttachments,
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

  it("preserves row order so the replayed fold is byte-stable", () => {
    const result = reconstructStoredAttachments([imageRow(), docRow()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments.map((a) => a.name)).toEqual([
      "chart.png",
      "notes.pdf",
    ]);
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

describe("isReplayableUploadMetadata", () => {
  it("mirrors the server requirements for the UI gate", () => {
    expect(
      isReplayableUploadMetadata("application/pdf", {
        storageEncoding: "base64",
        extractedText: "text",
      }),
    ).toBe(true);
    expect(
      isReplayableUploadMetadata("image/png", {
        storageEncoding: "base64",
        extractedText: "img",
      }),
    ).toBe(true);
    // Image without original bytes in base64 → not replayable.
    expect(
      isReplayableUploadMetadata("image/png", {
        storageEncoding: "utf8",
        extractedText: "img",
      }),
    ).toBe(false);
    expect(isReplayableUploadMetadata("application/pdf", {})).toBe(false);
    expect(isReplayableUploadMetadata(null, { extractedText: "x" })).toBe(
      false,
    );
  });
});
