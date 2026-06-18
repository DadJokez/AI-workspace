import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "@ai-workspace/agent/web-fetch-tool";

type LookupImpl = NonNullable<
  NonNullable<Parameters<typeof createWebFetchTool>[0]>["lookupImpl"]
>;

interface WebFetchOutput {
  text: string;
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  title: string | null;
  truncated: boolean;
  fetchedAt: string;
}

const publicLookup = (async () => [
  { address: "93.184.216.34", family: 4 },
]) as unknown as LookupImpl;

describe("web fetch built-in tool", () => {
  it("fetches public HTML and returns bounded readable content", async () => {
    const tool = createWebFetchTool({
      lookupImpl: publicLookup,
      now: () => new Date("2026-06-18T00:00:00Z"),
      fetchImpl: async () =>
        new Response(
          "<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
    });

    const output = (await tool.handler(
      { url: "https://example.com/", maxBytes: 4096 },
      { userId: "u1" },
    )) as WebFetchOutput;

    expect(output).toMatchObject({
      url: "https://example.com/",
      status: 200,
      ok: true,
      contentType: "text/html; charset=utf-8",
      title: "Example Domain",
      truncated: false,
      fetchedAt: "2026-06-18T00:00:00.000Z",
    });
    expect(output.text).toContain("<h1>Example Domain</h1>");
  });

  it("blocks private network destinations before fetching", async () => {
    const tool = createWebFetchTool({
      lookupImpl: (async () => [
        { address: "127.0.0.1", family: 4 },
      ]) as unknown as LookupImpl,
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });

    await expect(
      tool.handler({ url: "https://internal.example/" }, { userId: "u1" }),
    ).rejects.toThrow(/blocked private or reserved address/);
  });

  it("rejects credentialed and non-http URLs", async () => {
    const tool = createWebFetchTool({ lookupImpl: publicLookup });

    await expect(
      tool.handler({ url: "https://user:pass@example.com/" }, { userId: "u1" }),
    ).rejects.toThrow(/embedded credentials/);
    await expect(
      tool.handler({ url: "file:///etc/passwd" }, { userId: "u1" }),
    ).rejects.toThrow(/only supports http\(s\)/);
  });
});
