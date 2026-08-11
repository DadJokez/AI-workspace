import { MAX_TOKENS_TRUNCATION_NOTICE } from "@ai-workspace/agent";
import type { WorkspaceArtifact } from "@ai-workspace/db";
import { describe, expect, it } from "vitest";
import {
  planArtifactVersionsForExistingArtifacts,
  type WorkspaceArtifactVersionTarget,
} from "@/lib/artifact-revisions";
import {
  buildWorkspaceArtifactVersionSet,
  parseAssistantArtifacts,
} from "@/lib/workspace-artifacts";

describe("parseAssistantArtifacts", () => {
  it("extracts explicit filename code fences as workspace artifacts", () => {
    const artifacts = parseAssistantArtifacts(`
Here is the deck:

\`\`\`html filename="epic-universe-deck.html"
<!DOCTYPE html>
<html>
<head><title>Universal Epic Universe</title></head>
<body><h1>Universal Epic Universe</h1></body>
</html>
\`\`\`
`);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      filename: "epic-universe-deck.html",
      kind: "html",
      mimeType: "text/html",
      title: "Epic Universe Deck",
    });
  });

  it("extracts substantial standalone html without an explicit filename", () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Launch Plan</title></head>
<body>${"<section>Slide</section>".repeat(30)}</body>
</html>`;

    const artifacts = parseAssistantArtifacts(`
\`\`\`html
${html}
\`\`\`
`);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filename).toBe("launch-plan.html");
  });

  it("infers standalone html even when the fence has no language", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`
<!DOCTYPE html>
<html>
<head><title>Untyped Deck</title></head>
<body>${"<section>Slide</section>".repeat(30)}</body>
</html>
\`\`\`
`);

    expect(artifacts[0]?.filename).toBe("untyped-deck.html");
  });

  it("recovers complete html when the final code fence is left open", () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Advanced Magna Carta Jeopardy</title></head>
<body>${"<section>Question</section>".repeat(30)}</body>
</html>`;

    const artifacts = parseAssistantArtifacts(`
Here is the improved game:

\`\`\`html filename="advanced-magna-carta-jeopardy.html"
${html}`);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      filename: "advanced-magna-carta-jeopardy.html",
      kind: "html",
      mimeType: "text/html",
      title: "Advanced Magna Carta Jeopardy",
    });
    expect(artifacts[0]?.metadata).toMatchObject({
      recoveredUnclosedFence: true,
    });
  });

  it("does not persist cut-off html from an unclosed final code fence", () => {
    const artifacts = parseAssistantArtifacts(`
Here is the improved game:

\`\`\`html filename="advanced-magna-carta-jeopardy.html"
<!DOCTYPE html>
<html>
<head><title>Advanced Magna Carta Jeopardy</title></head>
<body>
  <div class="score">`);

    expect(artifacts).toHaveLength(0);
  });

  it("keeps the max_tokens truncation notice out of the recovered artifact", () => {
    // The #320 emit path: model is cut off mid-artifact (open ```html fence),
    // then runAgentLoop closes the dangling fence and appends the notice. The
    // notice must render as trailing prose, never as part of the saved .html.
    const html = `<!DOCTYPE html>
<html>
<head><title>Advanced Magna Carta Jeopardy</title></head>
<body>${"<section>Question</section>".repeat(30)}</body>
</html>`;
    const emitted = `
Here is the improved game:

\`\`\`html filename="advanced-magna-carta-jeopardy.html"
${html}
\`\`\`${MAX_TOKENS_TRUNCATION_NOTICE}`;

    const artifacts = parseAssistantArtifacts(emitted);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filename).toBe("advanced-magna-carta-jeopardy.html");
    expect(artifacts[0]?.content).not.toContain("output length limit");
    expect(artifacts[0]?.content).not.toContain(MAX_TOKENS_TRUNCATION_NOTICE);
    expect(artifacts[0]?.content).toContain("</html>");
  });

  it("does not persist explicit html snippets as complete artifacts", () => {
    const artifacts = parseAssistantArtifacts(`
Here is the updated section:

\`\`\`html filename="theme-picker.html"
<section class="theme-picker">Only the changed section</section>
\`\`\`
`);

    expect(artifacts).toHaveLength(0);
  });

  it("ignores tiny illustrative snippets without filenames", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`ts
const answer = 42;
\`\`\`
`);

    expect(artifacts).toHaveLength(0);
  });

  it("recovers a declared markdown file when the model forgot the fenced block", () => {
    const artifacts = parseAssistantArtifacts(`
Here's a comprehensive Markdown formatting reference:Written to \`markdown-formatting-reference.md\`.

Here's what's covered:

- **Headings** (H1-H6)
- **Text emphasis** — bold, italic, bold+italic, strikethrough
- **Tables** — basic, aligned, with in-cell formatting
- **GitHub Alerts** — NOTE, TIP, IMPORTANT, WARNING, CAUTION
`);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      filename: "markdown-formatting-reference.md",
      kind: "markdown",
      mimeType: "text/markdown",
      title: "Markdown Formatting Reference",
    });
    expect(artifacts[0]?.content).toContain("# Markdown Formatting Reference");
    expect(artifacts[0]?.content).toContain("Here's what's covered");
    expect(artifacts[0]?.content).not.toContain("Written to");
  });

  it("does not turn casual inline filenames into artifacts", () => {
    const artifacts = parseAssistantArtifacts(
      "I checked `README.md` and summarized the key points.",
    );

    expect(artifacts).toHaveLength(0);
  });

  // #647: a plain formatting request ("a heading and exactly three Markdown
  // bullets") must answer inline. When the turn shows no document-creation
  // intent, a short fenced block is chat formatting the model wrongly wrapped
  // as a file — even with an explicit filename.
  describe("#647 creation-intent gate", () => {
    const shortNamedFence = `Here you go:

\`\`\`markdown filename="Pilot-Plan.md"
# Pilot plan

- Invite testers
- Collect daily feedback
- Review results Friday
\`\`\`
`;

    it("drops a short named fence when the turn asked for formatting, not a file", () => {
      expect(
        parseAssistantArtifacts(shortNamedFence, {
          documentCreationIntent: false,
        }),
      ).toHaveLength(0);
    });

    it("keeps the same fence when the turn asked for a document", () => {
      const artifacts = parseAssistantArtifacts(shortNamedFence, {
        documentCreationIntent: true,
      });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.filename).toBe("Pilot-Plan.md");
    });

    it("keeps the same fence when intent is unknown (legacy callers)", () => {
      expect(parseAssistantArtifacts(shortNamedFence)).toHaveLength(1);
    });

    it("still persists a substantive document without detected intent", () => {
      const longDoc = `\`\`\`markdown filename="pilot-plan.md"
# Pilot plan

${"- A meaningful step in the pilot rollout plan\n".repeat(12)}
\`\`\`
`;
      const artifacts = parseAssistantArtifacts(longDoc, {
        documentCreationIntent: false,
      });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.filename).toBe("pilot-plan.md");
    });

    it("applies the same gate to short declared-save claims without a fence", () => {
      const declared =
        "# Pilot plan\n\n- Invite the five testers on Monday\n- Collect daily feedback in the shared form\n- Review the results together on Friday\n\nWritten to `Pilot-Plan.md`.";
      expect(
        parseAssistantArtifacts(declared, { documentCreationIntent: false }),
      ).toHaveLength(0);
      expect(
        parseAssistantArtifacts(declared, { documentCreationIntent: true }),
      ).toHaveLength(1);
    });
  });
});

describe("planArtifactVersionsForExistingArtifacts", () => {
  it("preserves the matched artifact identity when a revision emits a generic filename", () => {
    const artifacts = parseAssistantArtifacts(`
Here is the revised version:

\`\`\`html filename="updated.html"
<!doctype html>
<html>
<head><title>Updated</title></head>
<body><h1>Updated theme picker</h1></body>
</html>
\`\`\`
`);
    const targetArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker-v2.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [
        {
          id: "artifact-theme-v2",
          title: "Theme Picker",
          filename: "theme-picker-v2.html",
          artifactGroupId: "artifact-group-theme",
          versionNumber: 2,
          metadata: { artifactKey: "theme-picker.html" },
        },
      ],
      targetArtifact,
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]?.version).toMatchObject({
      artifactKey: "theme-picker.html",
      artifactGroupId: "artifact-group-theme",
      filename: "theme-picker.html",
      title: "Theme Picker",
      versionNumber: 3,
      supersedesArtifactId: "artifact-theme-v2",
    });
  });

  it("can continue versioning from the stored target when prior rows are unavailable", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="updated.html"
<!doctype html>
<html>
<head><title>Updated</title></head>
<body><h1>Updated theme picker</h1></body>
</html>
\`\`\`
`);
    const targetArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker-v2.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [],
      targetArtifact,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactGroupId: "artifact-group-theme",
      filename: "theme-picker.html",
      versionNumber: 3,
      supersedesArtifactId: "artifact-theme-v2",
    });
  });

  it("preserves the source artifact's visible filename casing on revision", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="updated.html"
<!doctype html>
<html>
<head><title>Budget Report</title></head>
<body><h1>Corrected totals</h1></body>
</html>
\`\`\`
`);
    const targetArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-budget-v2",
      title: "Budget Report",
      filename: "Budget-Report-v2.html",
      artifactGroupId: "artifact-group-budget",
      versionNumber: 2,
      metadata: { artifactKey: "budget-report.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [],
      targetArtifact,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactKey: "budget-report.html",
      artifactGroupId: "artifact-group-budget",
      filename: "Budget-Report.html",
      versionNumber: 3,
      supersedesArtifactId: "artifact-budget-v2",
    });
  });

  it("does not absorb a different file type into a matched artifact group", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`css filename="styles.css"
:root {
  color-scheme: light dark;
}

.theme-picker {
  accent-color: #005cff;
}
\`\`\`
`);
    const targetArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker-v2.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [],
      targetArtifact,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactKey: "styles.css",
      filename: "styles.css",
      versionNumber: 1,
      supersedesArtifactId: null,
    });
    expect(planned[0]?.version.artifactGroupId).not.toBe("artifact-group-theme");
    expect(planned[0]?.version.title).toBeUndefined();
  });

  it("does not absorb a same-extension artifact that already has its own group", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="report.html"
<!doctype html>
<html>
<head><title>Report</title></head>
<body><h1>Updated report</h1></body>
</html>
\`\`\`
`);
    const targetArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker-v2.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [
        {
          id: "artifact-theme-v2",
          title: "Theme Picker",
          filename: "theme-picker-v2.html",
          artifactGroupId: "artifact-group-theme",
          versionNumber: 2,
          metadata: { artifactKey: "theme-picker.html" },
        },
        {
          id: "artifact-report-v1",
          title: "Report",
          filename: "report.html",
          artifactGroupId: "artifact-group-report",
          versionNumber: 1,
          metadata: { artifactKey: "report.html" },
        },
      ],
      targetArtifact,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactKey: "report.html",
      artifactGroupId: "artifact-group-report",
      filename: "report.html",
      versionNumber: 2,
      supersedesArtifactId: "artifact-report-v1",
    });
    expect(planned[0]?.version.title).toBeUndefined();
  });

  it("#276 keeps an explicitly named copy in a separate artifact group", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="theme-picker-copy.html"
<!doctype html>
<html>
<head><title>Theme Picker Copy</title></head>
<body><h1>Forked theme picker</h1></body>
</html>
\`\`\`
`);

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [
        {
          id: "artifact-theme-v2",
          title: "Theme Picker",
          filename: "theme-picker.html",
          artifactGroupId: "artifact-group-theme",
          versionNumber: 2,
          metadata: { artifactKey: "theme-picker.html" },
        },
      ],
      targetArtifact: null,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactKey: "theme-picker-copy.html",
      filename: "theme-picker-copy.html",
      versionNumber: 1,
      supersedesArtifactId: null,
    });
    expect(planned[0]?.version.artifactGroupId).not.toBe("artifact-group-theme");
  });

  it("forks a matched artifact even when the model reuses the original filename", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="theme-picker.html"
<!doctype html>
<html>
<head><title>Theme Picker</title></head>
<body><h1>Copied theme picker</h1></body>
</html>
\`\`\`
`);
    const sourceArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [sourceArtifact],
      separateFromArtifact: sourceArtifact,
    });

    expect(planned[0]?.version).toMatchObject({
      artifactKey: "theme-picker-copy.html",
      filename: "theme-picker-copy.html",
      versionNumber: 1,
      supersedesArtifactId: null,
    });
    expect(planned[0]?.version.artifactGroupId).not.toBe("artifact-group-theme");
  });

  it("forks only the source artifact when a separate-copy response emits multiple files", () => {
    const artifacts = parseAssistantArtifacts(`
\`\`\`html filename="theme-picker.html"
<!doctype html>
<html>
<head><title>Theme Picker</title></head>
<body><h1>Copied theme picker</h1></body>
</html>
\`\`\`

\`\`\`css filename="theme-picker.css"
.theme-picker {
  color: cobalt;
}
\`\`\`
`);
    const sourceArtifact: WorkspaceArtifactVersionTarget = {
      id: "artifact-theme-v2",
      title: "Theme Picker",
      filename: "theme-picker.html",
      artifactGroupId: "artifact-group-theme",
      versionNumber: 2,
      metadata: { artifactKey: "theme-picker.html" },
    };

    const planned = planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: [sourceArtifact],
      separateFromArtifact: sourceArtifact,
    });

    expect(planned).toHaveLength(2);
    expect(planned[0]?.version).toMatchObject({
      artifactKey: "theme-picker-copy.html",
      filename: "theme-picker-copy.html",
      versionNumber: 1,
      supersedesArtifactId: null,
    });
    expect(planned[0]?.version.artifactGroupId).not.toBe("artifact-group-theme");
    expect(planned[1]?.version).toMatchObject({
      artifactKey: "theme-picker.css",
      filename: "theme-picker.css",
      versionNumber: 1,
      supersedesArtifactId: null,
    });
  });
});

describe("#685 review — the short-block gate is scoped to prose fences", () => {
  const fence = (lang: string, filename: string, body: string) =>
    "```" + lang + " filename=" + filename + "\n" + body + "\n```";

  it("keeps short code files the user explicitly named on an intent=false turn", () => {
    // "write a quicksort function in Python, call it quicksort.py" has no
    // document noun, and .py is not a recognized document extension, so the
    // turn classifies intent=false. Dropping these would discard a file the
    // user asked for BY NAME — the inverse of #647, and it would leave any
    // "saved to quicksort.py" claim unbacked.
    for (const [lang, name, body] of [
      ["python", "quicksort.py", "def quicksort(a):\n    return a"],
      ["sql", "active.sql", "SELECT 1;"],
      ["bash", "cleanup.sh", "rm -rf ./tmp"],
    ] as const) {
      const parsed = parseAssistantArtifacts(fence(lang, name, body), {
        documentCreationIntent: false,
      });
      expect(parsed.map((a) => a.filename), name).toContain(name);
    }
  });

  it("still drops the #647 case: a short markdown fence with no intent", () => {
    const parsed = parseAssistantArtifacts(
      fence("markdown", "Pilot-Plan.md", "# Pilot plan\n\n- invite testers"),
      { documentCreationIntent: false },
    );
    expect(parsed).toHaveLength(0);
  });

  it("still persists a short markdown fence when intent IS present", () => {
    const parsed = parseAssistantArtifacts(
      fence("markdown", "Pilot-Plan.md", "# Pilot plan\n\n- invite testers"),
      { documentCreationIntent: true },
    );
    expect(parsed.map((a) => a.filename)).toContain("Pilot-Plan.md");
  });
});

describe("buildWorkspaceArtifactVersionSet", () => {
  it("sorts immutable versions and marks an older selected version stale", () => {
    const v1 = artifactVersion({ id: "artifact-v1", versionNumber: 1 });
    const v2 = artifactVersion({
      id: "artifact-v2",
      versionNumber: 2,
      supersedesArtifactId: v1.id,
      createdAt: new Date("2026-08-11T13:00:00.000Z"),
    });

    expect(buildWorkspaceArtifactVersionSet(v1, [v2, v1])).toMatchObject({
      selectedArtifactId: v1.id,
      latestArtifactId: v2.id,
      staleBase: true,
      versions: [
        { id: v1.id, versionNumber: 1 },
        { id: v2.id, versionNumber: 2 },
      ],
    });
  });

  it("keeps the selected artifact when an incomplete query omits it", () => {
    const selected = artifactVersion({ id: "artifact-only", versionNumber: 1 });

    expect(buildWorkspaceArtifactVersionSet(selected, [])).toMatchObject({
      selectedArtifactId: selected.id,
      latestArtifactId: selected.id,
      staleBase: false,
      versions: [{ id: selected.id }],
    });
  });
});

function artifactVersion(
  overrides: Partial<WorkspaceArtifact> = {},
): WorkspaceArtifact {
  return {
    id: "artifact-v1",
    userId: "user-1",
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    title: "Quarterly brief",
    filename: "quarterly-brief.md",
    artifactGroupId: "artifact-group-1",
    versionNumber: 1,
    supersedesArtifactId: null,
    versionSummary: null,
    kind: "markdown",
    mimeType: "text/markdown",
    content: "# Quarterly brief",
    sizeBytes: 17,
    source: "assistant-code-block",
    metadata: {},
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:00:00.000Z"),
    ...overrides,
  };
}
