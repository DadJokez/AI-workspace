import { describe, expect, it } from "vitest";

import { buildProductionResourceFixtures } from "@/scripts/conversation-resource-smoke-fixtures";
import {
  SUPPORTED_BINARY_EXTENSIONS,
  validateAttachments,
} from "@/lib/attachments";

describe.sequential("production conversation resource fixtures (#576)", () => {
  it("keeps every production-gate fixture valid and semantically inspectable", async () => {
    const fixtures = await buildProductionResourceFixtures("fixture-test");

    expect(fixtures.map((fixture) => fixture.extension)).toEqual([
      "txt",
      "csv",
      "tsv",
      "xlsx",
      "pdf",
      "docx",
      "pptx",
      "png",
      "jpg",
      "jpeg",
      "webp",
    ]);

    for (const fixture of fixtures) {
      const validated = await validateAttachments([
        {
          name: fixture.filename,
          mimeType: fixture.mimeType,
          sizeBytes: fixture.bytes.byteLength,
          dataBase64: fixture.bytes.toString("base64"),
        },
      ]);

      expect(validated.ok, `${fixture.filename}: ${validated.error}`).toBe(true);
      expect(validated.attachments).toHaveLength(1);
      const attachment = validated.attachments[0]!;
      expect(attachment.sizeBytes).toBe(fixture.bytes.byteLength);

      if (
        (SUPPORTED_BINARY_EXTENSIONS as readonly string[]).includes(
          fixture.extension,
        ) &&
        fixture.kind === "image"
      ) {
        expect(attachment).toMatchObject({
          kind: "image",
          extractionStatus: "metadata_only",
          runtimeContent: { type: "image" },
        });
        expect(attachment.image?.width).toBe(1200);
        expect(attachment.image?.height).toBe(900);
        expect(
          Buffer.from(attachment.runtimeContent?.dataBase64 ?? "", "base64"),
        ).toEqual(fixture.bytes);
      } else {
        for (const fact of fixture.expectedFacts) {
          expect(attachment.content).toContain(fact);
        }
      }
    }
  });
});
