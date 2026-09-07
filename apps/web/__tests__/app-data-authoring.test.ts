import { describe, expect, it, vi } from "vitest";
import { workspaceArtifacts, type Database } from "@ai-workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { deriveAuthoringBindings } from "@/lib/app-data-authoring";
import { artifactDataMetadata, connectedDataProviders, detectEmbeddedConnectedData, readConnectedDataWarning } from "@/lib/app-data-authoring-warning";
import { authoringUsageNotes } from "@/lib/app-data-authoring-guidance";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";

function database(rows: { provider: string; toolName: string }[]) {
  const where = vi.fn(async (_condition: unknown) => rows);
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };
  return { db: db as unknown as Database, select: db.select, where };
}

describe("connected-data artifact authoring", () => {
  it("pins successful GitHub and Google read calls from the filtered catalog, never output", async () => {
    const { db, where } = database([{ provider: "github", toolName: "list_issues" }, { provider: "google", toolName: "search_mail" }]);
    const bindings = await deriveAuthoringBindings(db, [
      { id: "a", name: "github__list_issues", input: { owner: "org", repo: "demo" } },
      { id: "b", name: "google__search_mail", input: { query: "in:inbox" } },
      { id: "c", name: "github__create_issue", input: { title: "not a read" } },
    ], ["a", "b", "c"].map((toolCallId) => ({ toolCallId, output: "PRIVATE RECORD CONTENT" })));
    expect(bindings).toEqual([
      { id: "data-1", provider: "github", toolName: "list_issues", pinnedArgs: { owner: "org", repo: "demo" } },
      { id: "data-2", provider: "google", toolName: "search_mail", pinnedArgs: { query: "in:inbox" } },
    ]);
    expect(where).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.params).toEqual([true, "read", "always_allow"]);
    expect(JSON.stringify(bindings)).not.toContain("PRIVATE");
  });

  it("skips failed, absent, uncataloged, unsupported and oversized calls", async () => {
    const { db } = database([{ provider: "github", toolName: "list_issues" }]);
    const calls = ["failed", "absent", "oversize"].map((id) => ({ id, name: "github__list_issues", input: { value: id === "oversize" ? "x".repeat(16001) : id } }));
    calls.push({ id: "unsupported", name: "shared__list_issues", input: { value: "x" } });
    expect(await deriveAuthoringBindings(db, calls, [
      { toolCallId: "failed", isError: true, output: "no" },
      { toolCallId: "oversize", output: {} },
      { toolCallId: "unsupported", output: {} },
    ])).toEqual([]);
  });

  it("deduplicates and caps generic bindings, retaining legacy SOQL ids", async () => {
    const { db } = database([{ provider: "github", toolName: "list_issues" }]);
    const calls = Array.from({ length: 34 }, (_, n) => ({ id: String(n), name: "github__list_issues", input: { page: Math.floor(n / 2) } }));
    const bindings = await deriveAuthoringBindings(db, [
      { id: "soql", name: "salesforce__run_soql", input: { soql: "SELECT Id FROM Account LIMIT 5" } }, ...calls,
    ], calls.map((call) => ({ toolCallId: call.id, output: {} })));
    expect(bindings[0]?.id).toBe("soql-1");
    expect(bindings).toHaveLength(12);
    expect(bindings[1]?.id).toBe("data-2");
  });

  it("does not query the catalog on ordinary artifact turns", async () => {
    const { db, select } = database([]);
    expect(await deriveAuthoringBindings(db)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps prior bindings only when the caller supplies the matched version", () => {
    const prior = { dataBindings: [{ id: "data-1", provider: "github", toolName: "list_issues", pinnedArgs: { repo: "private" } }] };
    expect(artifactDataMetadata("<h1>Revised</h1>", [], [], prior)).toMatchObject(prior);
    expect(artifactDataMetadata("<h1>Other file</h1>", [], [])).not.toHaveProperty("dataBindings");
  });

  it("delivers authoring advice post-call without replacing existing action boundaries", () => {
    const notes = authoringUsageNotes({ search_mail: "always_allow", create_draft: "needs_approval", blocked: "blocked" }, { create_draft: "Draft only, not sent." });
    expect(notes.search_mail).toContain("refreshWidget");
    expect(notes.search_mail).toContain("Never embed connected records");
    expect(notes.search_mail).toContain('toolName for this call is "search_mail"');
    expect(notes.search_mail).toContain("return node;");
    expect(notes.create_draft).toBe("Draft only, not sent.");
    expect(notes.blocked).toBeUndefined();
  });

  it.each(["github", "google"])("persists %s bindings and the bake warning at artifact mint; scrubs client args", async (provider) => {
    const toolName = provider === "github" ? "list_issues" : "search_mail";
    let inserted: Record<string, unknown>[] = [];
    const db = {
      select: (fields?: unknown) => ({ from: () => ({ where: () => fields
        ? Promise.resolve([{ provider, toolName }])
        : { orderBy: () => ({ limit: async () => [] }) } }) }),
      insert: (table: unknown) => ({ values: (values: Record<string, unknown>[]) => {
        if (table !== workspaceArtifacts) return Promise.resolve();
        inserted = values;
        return { onConflictDoNothing: () => ({ returning: async () => values.map((value) => ({ ...value, id: "artifact-minted", createdAt: new Date() })) }) };
      } }),
    } as unknown as Database;
    const html = `<html><script>const rows=${JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id, description: "Private account data from connected provider" })))}</script></html>`;
    const result = await createArtifactsFromAssistantMessage({
      db, userId: "author", threadId: "same-thread", chatMessageId: "message", assistantText: '```html filename="dashboard.html"\n' + html + '\n```',
      turnToolCalls: [{ id: "read", name: `${provider}__${toolName}`, input: { query: "PINNED_PRIVATE_QUERY" } }],
      turnToolResults: [{ toolCallId: "read", output: {} }],
    });
    expect(inserted[0]?.metadata).toMatchObject({ dataBindings: [{ provider, toolName, pinnedArgs: { query: "PINNED_PRIVATE_QUERY" } }], connectedDataWarning: { providers: [provider] } });
    expect(result[0]?.metadata?.dataBindings).toEqual([{ id: "data-1", provider, toolName }]);
    expect(JSON.stringify(result)).not.toContain("PINNED_PRIVATE_QUERY");
  });

  it("warns about large embedded structures with successful connected provenance, even without bindings", () => {
    const html = `<script>const records = ${JSON.stringify(Array.from({ length: 15 }, (_, id) => ({ id, title: "Sensitive customer account description" })))}</script>`;
    const providers = connectedDataProviders([{ id: "a", name: "google__search_mail", input: {} }], [{ toolCallId: "a", output: {} }]);
    const warning = detectEmbeddedConnectedData(html, providers);
    expect(warning).toEqual({ kind: "possible_embedded_connected_data", providers: ["google"] });
    expect(detectEmbeddedConnectedData(html, [])).toBeNull();
    expect(detectEmbeddedConnectedData("<h1>Static title</h1>", providers)).toBeNull();
    expect(connectedDataProviders([{ id: "a", name: "google__search_mail", input: {} }], [{ toolCallId: "a", output: "fail", isError: true }])).toEqual([]);
    expect(readConnectedDataWarning({ connectedDataWarning: warning })).toEqual(warning);
    expect(readConnectedDataWarning({ connectedDataWarning: { kind: warning?.kind, providers: ["<script>"] } })).toBeNull();
  });
});
