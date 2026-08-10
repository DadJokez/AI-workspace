import { describe, expect, it } from "vitest";

import {
  MAX_CONTEXT_RESOURCE_REFERENCES,
  contextResourceReceiptSummary,
  contextResourceSearchResultsFromManifest,
  contextResourceSelectionsForPersistence,
  contextResourceStateLabel,
  parseContextResourceManifest,
  parseContextResourceReferences,
  parseContextResourceSearchResponse,
  type ContextResourceManifest,
} from "@/lib/context-shelf";

describe("context shelf contracts (#738)", () => {
  it("accepts only typed references, dedupes them, and enforces the selection limit", () => {
    const candidates = Array.from(
      { length: MAX_CONTEXT_RESOURCE_REFERENCES + 3 },
      (_, index) => ({
        version: 1,
        kind: "artifact",
        resourceId: `artifact-${index}`,
      }),
    );

    expect(
      parseContextResourceReferences([
        candidates[0],
        candidates[0],
        { version: 2, kind: "artifact", resourceId: "wrong-version" },
        { version: 1, kind: "unknown", resourceId: "wrong-kind" },
        ...candidates.slice(1),
      ]),
    ).toEqual(candidates.slice(0, MAX_CONTEXT_RESOURCE_REFERENCES));
  });

  it("requires a stable Gmail message and thread identity", () => {
    expect(
      parseContextResourceReferences([
        {
          version: 1,
          kind: "google_mail_thread",
          resourceId: "message-1",
        },
      ]),
    ).toEqual([]);
    expect(
      parseContextResourceReferences([
        {
          version: 1,
          kind: "google_mail_thread",
          resourceId: "message-1",
          containerId: "thread-1",
        },
      ]),
    ).toEqual([
      {
        version: 1,
        kind: "google_mail_thread",
        resourceId: "message-1",
        containerId: "thread-1",
      },
    ]);
  });

  it("sanitizes search labels while dropping malformed results and scopes", () => {
    const parsed = parseContextResourceSearchResponse({
      results: [
        {
          reference: {
            version: 1,
            kind: "vault_item",
            resourceId: "memory-1",
          },
          label: "A".repeat(300),
          description: "Direct communication preference",
          sourceLabel: "Vault",
        },
        { label: "Missing reference" },
      ],
      scopes: [
        {
          scope: "google_mail",
          label: "Gmail",
          description: "Search mail threads",
          available: false,
          unavailableReason: "Connect Google in Settings",
        },
        { scope: "unsupported", available: true },
      ],
    });

    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0]?.label).toHaveLength(240);
    expect(parsed?.scopes).toEqual([
      expect.objectContaining({
        scope: "google_mail",
        available: false,
        unavailableReason: "Connect Google in Settings",
      }),
    ]);
  });

  it("persists stable selection labels without connector search snippets", () => {
    expect(
      contextResourceSelectionsForPersistence([
        {
          reference: {
            version: 1,
            kind: "google_mail_thread",
            resourceId: "message-1",
            containerId: "thread-1",
          },
          label: "Quarterly plan",
          description: "Sensitive preview text from the message body",
          sourceLabel: "Gmail",
          provider: "google",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        label: "Quarterly plan",
        description: "",
        sourceLabel: "Gmail",
        provider: "google",
      }),
    ]);
  });

  it("restores browser labels from the authoritative persisted manifest", () => {
    const manifest = exampleManifest();
    expect(
      contextResourceSearchResultsFromManifest(undefined, manifest),
    ).toEqual([
      expect.objectContaining({
        label: "Launch brief",
        sourceLabel: "Artifact",
        versionLabel: "v3",
      }),
      expect.objectContaining({
        label: "Customer escalation",
        sourceLabel: "Gmail",
        provider: "google",
      }),
    ]);
  });

  it("summarizes included and unavailable resources without claiming missing context", () => {
    const manifest = exampleManifest();
    expect(contextResourceReceiptSummary(manifest)).toBe(
      "Using 1 file · 1 item needs attention",
    );
    expect(contextResourceStateLabel(manifest.items[1]!)).toBe(
      "Reconnect required",
    );
    expect(
      contextResourceStateLabel({
        reference: {
          version: 1,
          kind: "vault_item",
          resourceId: "memory-large",
        },
        label: "Large memory",
        sourceLabel: "Vault",
        state: "budget-omitted",
        reason: "oversize",
      }),
    ).toBe("Resource is too large");

    const reparsed = parseContextResourceManifest(manifest);
    expect(reparsed).toEqual(manifest);
    expect(
      parseContextResourceManifest({ version: 1, items: [{ state: "included" }] }),
    ).toEqual({ version: 1, items: [] });
  });
});

function exampleManifest(): ContextResourceManifest {
  return {
    version: 1,
    items: [
      {
        reference: {
          version: 1,
          kind: "artifact",
          resourceId: "artifact-brief",
        },
        label: "Launch brief",
        sourceLabel: "Artifact",
        state: "included",
        versionLabel: "v3",
        scope: "current thread",
        contentChars: 420,
      },
      {
        reference: {
          version: 1,
          kind: "google_mail_thread",
          resourceId: "message-1",
          containerId: "thread-1",
        },
        label: "Customer escalation",
        sourceLabel: "Gmail",
        state: "unavailable",
        reason: "reconnect_required",
        provider: "google",
      },
    ],
  };
}
