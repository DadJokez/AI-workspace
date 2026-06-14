import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  declaredAttachmentCountFromMessage,
  foldAttachmentsIntoPrompt,
  isSupportedAttachmentName,
  scanAttachmentsForSecrets,
  validateAttachments,
  type PreparedChatAttachment,
} from "@/lib/attachments";

/** Parity P1.1 — chat file attachments for common business files. */
describe("attachments", () => {
  describe("isSupportedAttachmentName", () => {
    it("accepts text, docs, spreadsheets, decks, PDFs, and images", () => {
      expect(isSupportedAttachmentName("report.csv")).toBe(true);
      expect(isSupportedAttachmentName("notes.md")).toBe(true);
      expect(isSupportedAttachmentName("data.JSON")).toBe(true);
      expect(isSupportedAttachmentName("photo.png")).toBe(true);
      expect(isSupportedAttachmentName("scan.pdf")).toBe(true);
      expect(isSupportedAttachmentName("deck.pptx")).toBe(true);
      expect(isSupportedAttachmentName("workbook.xlsx")).toBe(true);
      expect(isSupportedAttachmentName("brief.docx")).toBe(true);
      expect(isSupportedAttachmentName("noext")).toBe(false);
    });
  });

  describe("validateAttachments", () => {
    it("passes undefined/empty as a clean empty list", async () => {
      await expect(validateAttachments(undefined)).resolves.toEqual({
        ok: true,
        attachments: [],
      });
      await expect(validateAttachments([])).resolves.toEqual({
        ok: true,
        attachments: [],
      });
    });

    it("drops empty-content files silently", async () => {
      const r = await validateAttachments([
        { name: "a.txt", content: "real" },
        { name: "b.txt", content: "   " },
      ]);
      expect(r.ok).toBe(true);
      expect(r.attachments.map((a) => a.name)).toEqual(["a.txt"]);
    });

    it("rejects too many files", async () => {
      const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
        name: `f${i}.txt`,
        content: "x",
      }));
      expect((await validateAttachments(many)).ok).toBe(false);
    });

    it("rejects an oversized raw file", async () => {
      const bigBytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "x");
      const big = [
        {
          name: "big.txt",
          dataBase64: bigBytes.toString("base64"),
          sizeBytes: bigBytes.byteLength,
        },
      ];
      const r = await validateAttachments(big);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    it("truncates oversized extracted text instead of failing the turn", async () => {
      const r = await validateAttachments([
        { name: "big.txt", content: "x".repeat(MAX_ATTACHMENT_CHARS + 1) },
      ]);
      expect(r.ok).toBe(true);
      expect(r.attachments[0]?.content).toContain("Truncated after");
    });

    it("extracts client base64 text payloads", async () => {
      const r = await validateAttachments([
        {
          name: "q2.csv",
          mimeType: "text/csv",
          dataBase64: Buffer.from("rev,4.2M").toString("base64"),
          sizeBytes: 8,
        },
      ]);
      expect(r.ok).toBe(true);
      expect(r.attachments[0]).toMatchObject({
        name: "q2.csv",
        mimeType: "text/csv",
        kind: "spreadsheet",
        content: "rev,4.2M",
        storageEncoding: "base64",
      });
    });

    it("accepts image payloads with metadata and native runtime content", async () => {
      const png = Buffer.alloc(24);
      png.writeUInt32BE(640, 16);
      png.writeUInt32BE(480, 20);
      const r = await validateAttachments([
        {
          name: "screen.png",
          mimeType: "image/png",
          dataBase64: png.toString("base64"),
          sizeBytes: png.byteLength,
        },
      ]);
      expect(r.ok).toBe(true);
      expect(r.attachments[0]).toMatchObject({
        kind: "image",
        extractionStatus: "metadata_only",
        image: { width: 640, height: 480 },
      });
      expect(r.attachments[0]?.content).toContain("Image uploaded");
    });

    it("rejects a malformed shape", async () => {
      expect((await validateAttachments([{ name: "a.txt" }])).ok).toBe(false);
      expect((await validateAttachments("nope")).ok).toBe(false);
    });
  });

  describe("declaredAttachmentCountFromMessage", () => {
    it("detects the stale optimistic attachment marker", () => {
      expect(
        declaredAttachmentCountFromMessage(
          "Can you tell me about these screenshots?\n\n📎 2 files attached",
        ),
      ).toBe(2);
      expect(
        declaredAttachmentCountFromMessage("Here is the agenda\n\n📎 1 file attached"),
      ).toBe(1);
    });

    it("ignores normal messages without the exact marker", () => {
      expect(declaredAttachmentCountFromMessage("No files here")).toBeNull();
      expect(declaredAttachmentCountFromMessage("📎 files attached")).toBeNull();
    });
  });

  describe("foldAttachmentsIntoPrompt", () => {
    it("returns the message unchanged with no attachments", () => {
      expect(foldAttachmentsIntoPrompt("hi", [])).toBe("hi");
    });

    it("folds file contents under a labeled section the model can see", () => {
      const folded = foldAttachmentsIntoPrompt("summarize this", [
        preparedAttachment({ name: "q2.csv", content: "rev,4.2M" }),
      ]);
      expect(folded).toContain("summarize this");
      expect(folded).toContain("Attached file: q2.csv");
      expect(folded).toContain("rev,4.2M");
    });

    it("escapes fences when the content already contains triple backticks", () => {
      const folded = foldAttachmentsIntoPrompt("x", [
        preparedAttachment({ name: "code.md", content: "```js\\nx\\n```" }),
      ]);
      expect(folded).toContain("````"); // bumped to 4 backticks
    });
  });

  describe("scanAttachmentsForSecrets", () => {
    it("flags a credential-shaped string in an uploaded file", () => {
      const findings = scanAttachmentsForSecrets([
        preparedAttachment({
          name: "config.env",
          content: "TOKEN=ghp_" + "a".repeat(36),
        }),
      ]);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]).toContain("config.env");
    });

    it("is clean for ordinary content", () => {
      expect(
        scanAttachmentsForSecrets([
          preparedAttachment({ name: "notes.txt", content: "hello team" }),
        ]),
      ).toEqual([]);
    });
  });
});

function preparedAttachment({
  name,
  content,
}: {
  name: string;
  content: string;
}): PreparedChatAttachment {
  return {
    name,
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    kind: "text",
    content,
    storageContent: content,
    storageEncoding: "utf8",
    extractionStatus: "extracted",
  };
}
