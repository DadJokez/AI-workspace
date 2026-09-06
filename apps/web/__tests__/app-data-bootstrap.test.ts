import { describe, expect, it } from "vitest";
import {
  buildAppDataBootstrap,
  deriveBindingsFromTurnTools,
  injectAppDataBootstrap,
} from "@/lib/app-data-bootstrap";
import { MAX_DATA_BINDINGS } from "@/lib/app-data-bindings";

const soqlCall = (id: string, soql: string) => ({
  id,
  name: "salesforce__run_soql",
  input: { soql },
});

describe("deriveBindingsFromTurnTools", () => {
  it("derives a validated binding per successful run_soql call, in order", () => {
    const bindings = deriveBindingsFromTurnTools(
      [
        soqlCall("c1", "SELECT Id FROM Account"),
        { id: "c2", name: "salesforce__describe_object", input: { objectName: "Account" } },
        soqlCall("c3", "SELECT Id, Amount FROM Opportunity LIMIT 50"),
      ],
      [
        { toolCallId: "c1", output: {} },
        { toolCallId: "c3", output: {} },
      ],
    );
    expect(bindings.map((b) => b.id)).toEqual(["soql-1", "soql-2"]);
    // Emitted on the generic #802 shape: a pinned read-tool call.
    expect(bindings[0]).toEqual({
      id: "soql-1",
      provider: "salesforce",
      toolName: "run_soql",
      pinnedArgs: {
        // validateReadOnlySoql injects the default LIMIT.
        soql: expect.stringMatching(/^SELECT Id FROM Account LIMIT \d+$/),
      },
    });
    expect(bindings[1]!.pinnedArgs).toEqual({
      soql: "SELECT Id, Amount FROM Opportunity LIMIT 50",
    });
  });

  it("skips failed calls, invalid SOQL, and duplicate queries", () => {
    const bindings = deriveBindingsFromTurnTools(
      [
        soqlCall("bad", "SELECT Id FROM Lead"),
        soqlCall("notsoql", "DELETE FROM Account"),
        soqlCall("dup1", "SELECT Id FROM Contact LIMIT 5"),
        soqlCall("dup2", "SELECT Id FROM Contact LIMIT 5"),
      ],
      [{ toolCallId: "bad", output: "boom", isError: true }],
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.pinnedArgs).toEqual({
      soql: "SELECT Id FROM Contact LIMIT 5",
    });
  });

  it("caps at MAX_DATA_BINDINGS and returns empty without calls", () => {
    const calls = Array.from({ length: MAX_DATA_BINDINGS + 3 }, (_, n) =>
      soqlCall(`c${n}`, `SELECT Id FROM Account WHERE Name='x${n}' LIMIT 1`),
    );
    expect(deriveBindingsFromTurnTools(calls, [])).toHaveLength(
      MAX_DATA_BINDINGS,
    );
    expect(deriveBindingsFromTurnTools(undefined, undefined)).toEqual([]);
    expect(deriveBindingsFromTurnTools([], [])).toEqual([]);
  });
});

describe("buildAppDataBootstrap", () => {
  it("carries app id and binding ids but never query text", () => {
    const script = buildAppDataBootstrap("app-123", [
      { id: "soql-1", provider: "salesforce", toolName: "run_soql", label: "Pipeline" },
    ]);
    expect(script).toContain("app-123");
    expect(script).toContain("soql-1");
    expect(script).toContain("comparativeData");
    expect(script).not.toContain("SELECT");
  });

  it("escapes author-controlled labels so they cannot break out of the script", () => {
    const script = buildAppDataBootstrap("app-123", [
      {
        id: "soql-1",
        provider: "salesforce",
        toolName: "run_soql",
        label: "</script><script>alert(1)</script>",
      },
    ]);
    // The only literal </script> is the bootstrap's own closing tag.
    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).toContain("\\u003c/script");
  });
});

describe("injectAppDataBootstrap", () => {
  it("injects right after the opening head tag when present", () => {
    const html = '<!doctype html><html><head lang="en"><title>T</title></head><body></body></html>';
    const out = injectAppDataBootstrap(html, "<script>B</script>");
    expect(out.indexOf("<script>B</script>")).toBeGreaterThan(
      out.indexOf('<head lang="en">'),
    );
    expect(out.indexOf("<script>B</script>")).toBeLessThan(
      out.indexOf("<title>"),
    );
  });

  it("prepends when the document has no head", () => {
    const out = injectAppDataBootstrap("<div>page</div>", "<script>B</script>");
    expect(out.startsWith("<script>B</script>")).toBe(true);
    expect(out).toContain("<div>page</div>");
  });
});
