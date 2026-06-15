import { describe, expect, it } from "vitest";
import {
  parseTranscriptMarkdown,
  replayGoldenTranscript,
} from "./replay";

const config = {
  id: "sample",
  description: "sample transcript",
  expect: {
    availableCapabilities: ["vault", "github"],
    modelClaimsMatchLabels: true,
    describedFilesHaveArtifacts: true,
    attachmentMentionsHaveEvidence: true,
    noManualSaveInstructionsAfterArtifacts: true,
  },
};

function transcript(body: string, overrides: Partial<typeof config> = {}) {
  return [
    "<!-- golden-transcript",
    JSON.stringify({ ...config, ...overrides }, null, 2),
    "-->",
    "",
    "# Sample chat",
    "",
    "- Exported: 2026-06-15T12:00:00.000Z",
    "- Thread ID: thread_sample",
    "- Messages: 2",
    "",
    body.trim(),
    "",
  ].join("\n");
}

describe("golden transcript replay", () => {
  it("parses exported chat messages, artifacts, and activity receipts", () => {
    const parsed = parseTranscriptMarkdown(
      transcript(`
---

## 1. User

Please make a markdown file from the attached notes.

### Attachments
- notes.docx

---

## 2. Assistant - claude-sonnet-4-6

Written to \`notes-summary.md\`.

### Artifacts
- notes-summary.md (markdown, 2.0 KB) - /workspace/artifacts/artifact_1

### Activity
- [succeeded] Stored assistant answer
`),
    );

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.attachments).toEqual(["notes.docx"]);
    expect(parsed.artifacts).toEqual(["notes-summary.md"]);
    expect(parsed.activityReceipts).toEqual([
      "[succeeded] Stored assistant answer",
    ]);
  });

  it("passes a fixed transcript with capabilities, model label, attachments, and artifacts", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Please summarize the attached notes and write a markdown file.

### Attachments
- notes.docx

---

## 2. Assistant - claude-sonnet-4-6

GitHub is connected, and I can use your Vault context. Written to \`notes-summary.md\`.

### Artifacts
- notes-summary.md (markdown, 2.0 KB) - /workspace/artifacts/artifact_1

### Activity
- [succeeded] Stored assistant answer
`),
    );

    expect(result.passed).toBe(true);
    expect(result.parsed.modelLabels).toEqual(["claude-sonnet-4-6"]);
  });

  it("fails when the assistant denies connected capabilities", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Do you have access to my vault and GitHub?

---

## 2. Assistant - claude-sonnet-4-6

I don't have access to your Vault, and no tools are connected.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions.filter((assertion) => !assertion.ok)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "does not deny available vault" }),
        expect.objectContaining({ label: "does not deny available github" }),
      ]),
    );
  });

  it("scans assistant-authored markdown headings as message content", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Can you use GitHub?

---

## 2. Assistant - claude-sonnet-4-6

### Tool check

I don't have GitHub access.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "does not deny available github" }),
      ]),
    );
  });

  it("fails when model claims disagree with assistant labels", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

What model are you?

---

## 2. Assistant - claude-sonnet-4-6

You are talking to Haiku.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "assistant model claims match transcript labels",
          ok: false,
        }),
      ]),
    );
  });

  it("fails when a version-leading model claim disagrees with the label", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

What model are you?

---

## 2. Assistant - claude-haiku-4-5

I'm Claude 3.5 Sonnet.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "assistant model claims match transcript labels",
          ok: false,
        }),
      ]),
    );
  });

  it("does not treat model availability lists as identity-claim mismatches", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Which writing model should we use?

---

## 2. Assistant - claude-sonnet-4-6

I am Claude Sonnet 4.6. Haiku, Sonnet, and Opus are all available in the platform, but Sonnet is the best fit here.
`),
    );

    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "assistant model claims match transcript labels",
          ok: true,
        }),
      ]),
    );
  });

  it("does not let model identity claims bleed across sentence boundaries", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

What model are you?

---

## 2. Assistant - claude-opus-4-1

I am Claude. The Sonnet and Haiku models are available for other work.
`),
    );

    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "assistant model claims match transcript labels",
          ok: true,
        }),
      ]),
    );
  });

  it("fails when a generated file has no artifact reference", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Make a markdown reference.

---

## 2. Assistant - claude-sonnet-4-6

Written to \`markdown-reference.md\`.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "described generated files have artifact references",
          ok: false,
        }),
      ]),
    );
  });

  it("does not require source attachment filenames to be generated artifacts", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Please summarize my source file.

### Attachments
- notes.docx

---

## 2. Assistant - claude-sonnet-4-6

I summarized your \`notes.docx\` and wrote \`notes-summary.md\`.

### Artifacts
- notes-summary.md (markdown, 2.0 KB) - /workspace/artifacts/artifact_1
`),
    );

    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "described generated files have artifact references",
          ok: true,
        }),
      ]),
    );
  });

  it("fails when artifact messages still include manual save instructions", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Make an HTML demo.

---

## 2. Assistant - claude-sonnet-4-6

Copy all the code above and save it as \`demo.html\`.

### Artifacts
- demo.html (html, 1.0 KB) - /workspace/artifacts/artifact_1
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "artifact messages do not include manual copy/save instructions",
          ok: false,
        }),
      ]),
    );
  });

  it("fails when attachments are mentioned but no evidence exists", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

What can you tell me about these screenshots?

---

## 2. Assistant - claude-sonnet-4-6

I can look at the attached screenshots.
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "attachment mentions have attachment or artifact evidence",
          ok: false,
        }),
      ]),
    );
  });

  it("requires attachment evidence for screenshot/image mentions", () => {
    const result = replayGoldenTranscript(
      transcript(`
---

## 1. User

Can you look at this file?

---

## 2. Assistant - claude-sonnet-4-6

I can see the screenshots you uploaded and wrote notes to \`screenshot-notes.md\`.

### Artifacts
- screenshot-notes.md (markdown, 1.0 KB) - /workspace/artifacts/artifact_1
`),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "attachment mentions have attachment or artifact evidence",
          ok: false,
        }),
      ]),
    );
  });
});
