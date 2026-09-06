import { describe, expect, it } from "vitest";
import {
  APP_PUBLICATION_SCHEMA,
  connectorManifestForBindings,
  createAppPublicationMetadata,
  describeConnectorManifest,
  injectAppPublicationBadge,
  isBindingIncludedInPublication,
  parseRequestedPublicationMode,
  resolveAppPublication,
  stampAppPublicationMetadata,
} from "@/lib/app-publication";

const binding = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  pinnedArgs: { soql: "SELECT Id FROM Opportunity LIMIT 10" },
  label: "Pipeline",
};
const issuesBinding = {
  id: "issues",
  provider: "github",
  toolName: "list_issues",
  pinnedArgs: { owner: "DadJokez", repo: "AI-workspace" },
};
const legacyBinding = {
  id: "legacy",
  provider: "salesforce",
  kind: "soql",
  query: "SELECT Id FROM Account LIMIT 5",
};

describe("app publication metadata", () => {
  it("defaults new requests to snapshot and rejects unsupported modes", () => {
    expect(parseRequestedPublicationMode(undefined)).toBe("snapshot");
    expect(parseRequestedPublicationMode("snapshot")).toBe("snapshot");
    expect(parseRequestedPublicationMode("live_via_viewer")).toBe(
      "live_via_viewer",
    );
    expect(parseRequestedPublicationMode("service_backed")).toBeNull();
  });

  it("creates a catalog-keyed manifest only for explicit live publication", () => {
    const publication = createAppPublicationMetadata({
      artifactMetadata: { dataBindings: [binding] },
      dataMode: "live_via_viewer",
      publishedAt: new Date("2026-07-23T12:00:00.000Z"),
      publishedByUserId: "user-1",
      audience: "named",
    });

    expect(publication).toEqual({
      schema: APP_PUBLICATION_SCHEMA,
      dataMode: "live_via_viewer",
      publishedAt: "2026-07-23T12:00:00.000Z",
      publishedByUserId: "user-1",
      audience: "named",
      connectorManifest: [
        {
          provider: "salesforce",
          toolName: "run_soql",
          catalogKey: "salesforce:run_soql",
          bindingIds: ["pipeline"],
        },
      ],
    });
    expect(isBindingIncludedInPublication(publication, binding)).toBe(true);
    expect(
      isBindingIncludedInPublication(publication, {
        id: "undeclared",
        provider: "salesforce",
        toolName: "run_soql",
      }),
    ).toBe(false);
    // Same id on a different tool is a different declaration.
    expect(
      isBindingIncludedInPublication(publication, {
        id: "pipeline",
        provider: "salesforce",
        toolName: "get_record",
      }),
    ).toBe(false);
    expect(
      createAppPublicationMetadata({
        artifactMetadata: { dataBindings: [binding] },
        dataMode: "snapshot",
        publishedAt: new Date("2026-07-23T12:00:00.000Z"),
        publishedByUserId: "user-1",
        audience: "private",
      }).connectorManifest,
    ).toEqual([]);
  });

  it("declares every (provider, tool) a version's bindings call, legacy SOQL included", () => {
    const manifest = connectorManifestForBindings([
      binding,
      issuesBinding,
      { ...binding, id: "pipeline-2" },
    ]);
    expect(manifest).toEqual([
      {
        provider: "salesforce",
        toolName: "run_soql",
        catalogKey: "salesforce:run_soql",
        bindingIds: ["pipeline", "pipeline-2"],
      },
      {
        provider: "github",
        toolName: "list_issues",
        catalogKey: "github:list_issues",
        bindingIds: ["issues"],
      },
    ]);
    expect(
      createAppPublicationMetadata({
        artifactMetadata: { dataBindings: [legacyBinding] },
        dataMode: "live_via_viewer",
        publishedAt: new Date(),
        publishedByUserId: "user-1",
        audience: "private",
      }).connectorManifest,
    ).toEqual([
      {
        provider: "salesforce",
        toolName: "run_soql",
        catalogKey: "salesforce:run_soql",
        bindingIds: ["legacy"],
      },
    ]);
  });

  it("describes declared sources with the Settings card name", () => {
    expect(
      describeConnectorManifest(
        connectorManifestForBindings([binding, issuesBinding]),
      ),
    ).toEqual([
      {
        provider: "salesforce",
        providerLabel: "Salesforce",
        toolName: "run_soql",
        catalogKey: "salesforce:run_soql",
        bindingCount: 1,
      },
      {
        provider: "github",
        providerLabel: "GitHub",
        toolName: "list_issues",
        catalogKey: "github:list_issues",
        bindingCount: 1,
      },
    ]);
  });

  it("refuses live mode when there is no supported binding", () => {
    expect(() =>
      createAppPublicationMetadata({
        artifactMetadata: {},
        dataMode: "live_via_viewer",
        publishedAt: new Date(),
        publishedByUserId: "user-1",
        audience: "private",
      }),
    ).toThrow("requires at least one supported data binding");
  });

  it("preserves existing metadata while stamping the publication contract", () => {
    const publication = createAppPublicationMetadata({
      artifactMetadata: {},
      dataMode: "snapshot",
      publishedAt: new Date("2026-07-23T12:00:00.000Z"),
      publishedByUserId: "user-1",
      audience: "private",
    });
    expect(
      stampAppPublicationMetadata({ proposal: { status: "accepted" } }, publication),
    ).toEqual({
      proposal: { status: "accepted" },
      appPublication: publication,
    });
  });

  it("keeps pre-contract binding apps live through an explicit legacy fallback", () => {
    const resolved = resolveAppPublication(
      { dataBindings: [legacyBinding] },
      new Date("2026-01-01T00:00:00.000Z"),
      "legacy-owner",
    );
    expect(resolved.legacyInferred).toBe(true);
    expect(resolved.metadata.dataMode).toBe("live_via_viewer");
    expect(resolved.metadata.connectorManifest).toEqual([
      {
        provider: "salesforce",
        toolName: "run_soql",
        catalogKey: "salesforce:run_soql",
        bindingIds: ["legacy"],
      },
    ]);
  });
});

describe("published app badge", () => {
  it("injects truthful snapshot provenance and escapes author-controlled text", () => {
    const publication = createAppPublicationMetadata({
      artifactMetadata: {},
      dataMode: "snapshot",
      publishedAt: new Date("2026-07-23T12:00:00.000Z"),
      publishedByUserId: "user-1",
      audience: "private",
    });
    const html = injectAppPublicationBadge(
      "<!doctype html><html><body><main>Hello</main></body></html>",
      { publication, authorName: '<script>alert("x")</script>' },
    );

    expect(html).toContain('id="comparative-publication-badge"');
    expect(html).toContain("Snapshot · Published");
    expect(html).toContain("publish a new version to refresh");
    expect(html).not.toContain("Data as of");
    expect(html).toContain(
      "By &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(html).not.toContain('By <script>alert("x")</script>');
    expect(html.indexOf("comparative-publication-badge")).toBeLessThan(
      html.indexOf("<main>"),
    );
  });

  it("names the declared sources on a live page, never the pinned arguments", () => {
    const publication = createAppPublicationMetadata({
      artifactMetadata: { dataBindings: [binding, issuesBinding] },
      dataMode: "live_via_viewer",
      publishedAt: new Date("2026-07-23T12:00:00.000Z"),
      publishedByUserId: "user-1",
      audience: "named",
    });
    const html = injectAppPublicationBadge("<html><body></body></html>", {
      publication,
      authorName: "Brittany",
    });
    expect(html).toContain(
      "Live via your connections · Salesforce run_soql, GitHub list_issues",
    );
    expect(html).not.toContain("Opportunity");
    expect(html).not.toContain("DadJokez");
  });
});
