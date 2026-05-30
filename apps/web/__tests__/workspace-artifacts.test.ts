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
});
