import { describe, expect, it } from "vitest";
import { extractAssistantSources, parseAssistantSources } from "./sources";

describe("extractAssistantSources", () => {
  it("extracts and deduplicates GitHub pull request and issue links", () => {
    expect(
      extractAssistantSources({
        toolCalls: [
          {
            id: "call-list",
            name: "github__list_pull_requests",
            provider: "github",
            toolName: "list_pull_requests",
            input: { owner: "DadJokez", repo: "AI-workspace" },
          },
        ],
        toolResults: [
          {
            toolCallId: "call-list",
            provider: "github",
            toolName: "list_pull_requests",
            output: {
              pullRequests: [
                {
                  number: 42,
                  title: "Ship citations",
                  html_url:
                    "https://github.com/DadJokez/AI-workspace/pull/42",
                },
                {
                  title: "Duplicate link",
                  html_url:
                    "https://github.com/DadJokez/AI-workspace/pull/42",
                },
              ],
              issue: {
                number: 523,
                title: "Citation UI",
                url: "https://api.github.com/repos/DadJokez/AI-workspace/issues/523",
              },
            },
          },
        ],
      }),
    ).toEqual([
      {
        n: 1,
        title: "Ship citations",
        url: "https://github.com/DadJokez/AI-workspace/pull/42",
        kind: "repo",
        toolCallId: "call-list",
      },
      {
        n: 2,
        title: "Citation UI",
        url: "https://github.com/DadJokez/AI-workspace/issues/523",
        kind: "repo",
        toolCallId: "call-list",
      },
    ]);
  });

  it("does not promote nested GitHub entities from a realistic MCP pull request payload", () => {
    const pullRequestUrl =
      "https://github.com/DadJokez/AI-workspace/pull/543";
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            number: 543,
            title: "Add grounded source chips",
            html_url: pullRequestUrl,
            body: "Related text mentions https://github.com/other/repo/issues/9",
            user: {
              login: "contributor",
              html_url: "https://github.com/contributor",
            },
            head: {
              repo: {
                name: "AI-workspace-fork",
                html_url: "https://github.com/contributor/AI-workspace",
              },
            },
            base: {
              repo: {
                name: "AI-workspace",
                html_url: "https://github.com/DadJokez/AI-workspace",
              },
            },
            assignee: {
              login: "reviewer",
              html_url: "https://github.com/reviewer",
            },
            merged_by: {
              login: "maintainer",
              html_url: "https://github.com/maintainer",
            },
            requested_reviewers: [
              {
                login: "second-reviewer",
                html_url: "https://github.com/second-reviewer",
              },
            ],
          }),
        },
      ],
    };

    expect(
      extractAssistantSources({
        toolResults: [
          {
            toolCallId: "call-realistic-pr",
            provider: "github",
            toolName: "get_pull_request",
            output,
          },
        ],
      }),
    ).toEqual([
      {
        n: 1,
        title: "Add grounded source chips",
        url: pullRequestUrl,
        kind: "repo",
        toolCallId: "call-realistic-pr",
      },
    ]);
  });

  it("builds a repository file link from tool input and JSON text output", () => {
    expect(
      extractAssistantSources({
        toolCalls: [
          {
            id: "call-file",
            name: "github__get_file_contents",
            input: {
              owner: "DadJokez",
              repo: "AI-workspace",
              path: "apps/web/app/chat/page.tsx",
              ref: "main",
            },
          },
        ],
        toolResults: [
          {
            toolCallId: "call-file",
            name: "github__get_file_contents",
            output: JSON.stringify({
              path: "apps/web/app/chat/page.tsx",
              content: "ignored base64 or source content",
            }),
          },
        ],
      }),
    ).toEqual([
      {
        n: 1,
        title: "apps/web/app/chat/page.tsx",
        url: "https://github.com/DadJokez/AI-workspace/blob/main/apps/web/app/chat/page.tsx",
        kind: "repo",
        toolCallId: "call-file",
      },
    ]);
  });

  it("extracts links from MCP text content without trailing punctuation", () => {
    expect(
      extractAssistantSources({
        toolResults: [
          {
            toolCallId: "call-text",
            provider: "github",
            toolName: "get_pull_request",
            output: {
              content: [
                {
                  type: "text",
                  text: "Reviewed https://github.com/DadJokez/AI-workspace/pull/42.",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      {
        n: 1,
        title: "DadJokez/AI-workspace/pull/42",
        url: "https://github.com/DadJokez/AI-workspace/pull/42",
        kind: "repo",
        toolCallId: "call-text",
      },
    ]);
  });

  it("keeps hostile titles as data and rejects unsafe URLs", () => {
    const sources = extractAssistantSources({
      toolResults: [
        {
          toolCallId: "call-hostile",
          provider: "github",
          toolName: "get_issue",
          output: [
            {
              title: '<img src=x onerror="globalThis.pwned=true">',
              html_url: "https://github.com/DadJokez/AI-workspace/issues/1",
            },
            { title: "Bad", html_url: "javascript:alert(1)" },
          ],
        },
      ],
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toBe(
      '<img src=x onerror="globalThis.pwned=true">',
    );
  });

  it("ignores failed and non-GitHub tool results", () => {
    expect(
      extractAssistantSources({
        toolResults: [
          {
            toolCallId: "failed",
            provider: "github",
            output: "https://github.com/DadJokez/AI-workspace/pull/1",
            isError: true,
          },
          {
            toolCallId: "google",
            provider: "google",
            output: "https://github.com/DadJokez/AI-workspace/pull/2",
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("parseAssistantSources", () => {
  it("validates persisted source metadata without allowing active URLs", () => {
    expect(
      parseAssistantSources([
        {
          n: 2,
          title: "Second",
          kind: "web",
          url: "https://example.com/source",
        },
        {
          n: 1,
          title: "First",
          kind: "artifact",
          url: "/api/workspace/artifacts/one/preview",
        },
        {
          n: 3,
          title: "Unsafe",
          kind: "web",
          url: "javascript:alert(1)",
        },
        {
          n: 4,
          title: "Protocol relative",
          kind: "web",
          url: "//evil.example/source",
        },
        {
          n: 5,
          title: "Insecure transport",
          kind: "web",
          url: "http://example.com/source",
        },
      ]),
    ).toEqual([
      {
        n: 1,
        title: "First",
        kind: "artifact",
        url: "/api/workspace/artifacts/one/preview",
      },
      {
        n: 2,
        title: "Second",
        kind: "web",
        url: "https://example.com/source",
      },
      { n: 3, title: "Unsafe", kind: "web" },
      { n: 4, title: "Protocol relative", kind: "web" },
      { n: 5, title: "Insecure transport", kind: "web" },
    ]);
  });
});
