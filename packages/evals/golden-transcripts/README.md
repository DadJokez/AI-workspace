# Golden Transcript Replay

Golden transcripts turn downloaded chat bugs into deterministic regression
fixtures. Run them with:

```bash
pnpm transcripts:replay
```

Each fixture is a downloaded chat Markdown file plus a `golden-transcript` JSON
comment near the top:

```md
<!-- golden-transcript
{
  "id": "short-stable-id",
  "description": "what regression this locks",
  "expect": {
    "availableCapabilities": ["vault", "github"],
    "modelClaimsMatchLabels": true,
    "describedFilesHaveArtifacts": true,
    "attachmentMentionsHaveEvidence": true,
    "noManualSaveInstructionsAfterArtifacts": true
  }
}
-->
```

## Redaction Rules

- Remove names, emails, tokens, private repo names, customer names, and URLs that
  should not live in git.
- Replace real account data with stable fake values such as `Rob Example`,
  `example/repo`, `artifact_1`, or `notes.docx`.
- Keep the failure shape intact: assistant wording, model labels, artifact
  sections, attachment sections, and activity receipts should still resemble the
  downloaded chat.
- Do not commit raw screenshots, PDFs, docs, spreadsheets, or private tool
  payloads here. Represent them as `### Attachments` list items instead.
