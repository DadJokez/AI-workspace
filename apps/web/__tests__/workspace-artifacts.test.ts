import { describe, expect, it } from "vitest";
import { parseAssistantArtifacts } from "@/lib/workspace-artifacts";

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
});
