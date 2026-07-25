import { describe, expect, it } from "vitest";
import { transcriptFilenameFromContentDisposition } from "@/app/chat/chat-client-presentation";

describe("transcriptFilenameFromContentDisposition", () => {
  it("parses a quoted filename", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        'attachment; filename="2026-07-24-weekly-status.md"',
      ),
    ).toBe("2026-07-24-weekly-status.md");
  });

  it("parses an unquoted filename token", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        "attachment; filename=2026-07-24-weekly-status.md",
      ),
    ).toBe("2026-07-24-weekly-status.md");
  });

  it("prefers the RFC 5987 filename* form and decodes it", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        "attachment; filename*=UTF-8''caf%C3%A9-notes.md; filename=\"fallback.md\"",
      ),
    ).toBe("café-notes.md");
  });

  it("falls back to plain filename when filename* decoding fails", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        "attachment; filename*=UTF-8''%E0%A4%A; filename=\"fallback.md\"",
      ),
    ).toBe("fallback.md");
  });

  it("strips path separators so headers cannot escape the download name", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        'attachment; filename="../../etc/transcript.md"',
      ),
    ).toBe("....etctranscript.md");
    expect(
      transcriptFilenameFromContentDisposition(
        'attachment; filename="..\\..\\transcript.md"',
      ),
    ).toBe("....transcript.md");
  });

  it("strips control characters", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        'attachment; filename="tran\u0000scr\u001fipt\u007f.md"',
      ),
    ).toBe("transcript.md");
  });

  it("rejects names that are not plain .md files", () => {
    expect(
      transcriptFilenameFromContentDisposition(
        'attachment; filename="evil.html"',
      ),
    ).toBeUndefined();
    expect(
      transcriptFilenameFromContentDisposition('attachment; filename=".md"'),
    ).toBeUndefined();
    expect(
      transcriptFilenameFromContentDisposition('attachment; filename=""'),
    ).toBeUndefined();
  });

  it("returns undefined for a missing or filename-less header", () => {
    expect(transcriptFilenameFromContentDisposition(null)).toBeUndefined();
    expect(
      transcriptFilenameFromContentDisposition("attachment"),
    ).toBeUndefined();
  });
});
