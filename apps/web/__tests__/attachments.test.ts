import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CHARS,
  foldAttachmentsIntoPrompt,
  isSupportedAttachmentName,
  scanAttachmentsForSecrets,
  validateAttachments,
} from "@/lib/attachments";

/** Parity P1.1 — chat file attachments (text documents v1). */
describe("attachments", () => {
  describe("isSupportedAttachmentName", () => {
    it("accepts text-extractable types, rejects binaries", () => {
      expect(isSupportedAttachmentName("report.csv")).toBe(true);
      expect(isSupportedAttachmentName("notes.md")).toBe(true);
      expect(isSupportedAttachmentName("data.JSON")).toBe(true);
      expect(isSupportedAttachmentName("photo.png")).toBe(false);
      expect(isSupportedAttachmentName("scan.pdf")).toBe(false);
      expect(isSupportedAttachmentName("noext")).toBe(false);
    });
  });

  describe("validateAttachments", () => {
    it("passes undefined/empty as a clean empty list", () => {
      expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
      expect(validateAttachments([])).toEqual({ ok: true, attachments: [] });
    });

    it("drops empty-content files silently", () => {
      const r = validateAttachments([
        { name: "a.txt", content: "real" },
        { name: "b.txt", content: "   " },
      ]);
      expect(r.ok).toBe(true);
      expect(r.attachments.map((a) => a.name)).toEqual(["a.txt"]);
    });

    it("rejects too many files", () => {
      const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
        name: `f${i}.txt`,
        content: "x",
      }));
      expect(validateAttachments(many).ok).toBe(false);
    });

    it("rejects an oversized file", () => {
      const big = [{ name: "big.txt", content: "x".repeat(MAX_ATTACHMENT_CHARS + 1) }];
      const r = validateAttachments(big);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    it("rejects a malformed shape", () => {
      expect(validateAttachments([{ name: "a.txt" }]).ok).toBe(false);
      expect(validateAttachments("nope").ok).toBe(false);
    });
  });

  describe("foldAttachmentsIntoPrompt", () => {
    it("returns the message unchanged with no attachments", () => {
      expect(foldAttachmentsIntoPrompt("hi", [])).toBe("hi");
    });

    it("folds file contents under a labeled section the model can see", () => {
      const folded = foldAttachmentsIntoPrompt("summarize this", [
        { name: "q2.csv", content: "rev,4.2M" },
      ]);
      expect(folded).toContain("summarize this");
      expect(folded).toContain("Attached file: q2.csv");
      expect(folded).toContain("rev,4.2M");
    });

    it("escapes fences when the content already contains triple backticks", () => {
      const folded = foldAttachmentsIntoPrompt("x", [
        { name: "code.md", content: "```js\\nx\\n```" },
      ]);
      expect(folded).toContain("````"); // bumped to 4 backticks
    });
  });

  describe("scanAttachmentsForSecrets", () => {
    it("flags a credential-shaped string in an uploaded file", () => {
      const findings = scanAttachmentsForSecrets([
        { name: "config.env", content: "TOKEN=ghp_" + "a".repeat(36) },
      ]);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]).toContain("config.env");
    });

    it("is clean for ordinary content", () => {
      expect(
        scanAttachmentsForSecrets([{ name: "notes.txt", content: "hello team" }]),
      ).toEqual([]);
    });
  });
});
