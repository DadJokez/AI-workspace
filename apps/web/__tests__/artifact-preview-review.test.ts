// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreviewContent } from "@/components/ArtifactPreviewPane";
import type {
  WorkspaceArtifactDetail,
  WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";

const v1 = artifactSummary({
  id: "artifact-v1",
  versionNumber: 1,
  supersedesArtifactId: null,
  createdAt: "2026-08-10T12:00:00.000Z",
});
const v2 = artifactSummary({
  id: "artifact-v2",
  versionNumber: 2,
  supersedesArtifactId: v1.id,
  createdAt: "2026-08-11T12:00:00.000Z",
});
const details: Record<string, WorkspaceArtifactDetail> = {
  [v1.id]: { ...v1, content: "# Brief\n\nOld line\n\nShared line" },
  [v2.id]: { ...v2, content: "# Brief\n\nNew line\n\nShared line" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/versions")) {
        const selectedArtifactId = path.split("/").at(-2) ?? v2.id;
        return Response.json({
          selectedArtifactId,
          latestArtifactId: v2.id,
          staleBase: selectedArtifactId !== v2.id,
          versions: [v1, v2],
        });
      }
      const id = path.split("/").at(-1) ?? "";
      const artifact = details[id];
      return artifact
        ? Response.json({ artifact })
        : Response.json({ error: "artifact_not_found" }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ArtifactPreviewContent review modes", () => {
  it("switches from rendered preview to source and an immutable version diff", async () => {
    render(createElement(ArtifactPreviewContent, { artifact: v2 }));

    const sourceTab = await screen.findByRole("tab", { name: "Source" });
    fireEvent.click(sourceTab);
    expect(
      (await screen.findByTestId("artifact-source-view")).textContent,
    ).toContain("New line");

    fireEvent.keyDown(sourceTab, { key: "ArrowRight" });
    const compareTab = screen.getByRole("tab", { name: "Compare" });
    expect(compareTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(compareTab);
    const comparison = await screen.findByTestId(
      "artifact-version-comparison",
    );
    await waitFor(() => {
      expect(comparison.textContent).toContain("Old line");
      expect(comparison.textContent).toContain("New line");
      expect(comparison.textContent).toContain("+1");
      expect(comparison.textContent).toContain("-1");
    });
    expect(
      (screen.getByLabelText("From version") as HTMLSelectElement).value,
    ).toBe(v1.id);
    expect(
      (screen.getByLabelText("To version") as HTMLSelectElement).value,
    ).toBe(v2.id);
  });

  it("warns on a stale base and compares it directly with the latest version", async () => {
    render(createElement(ArtifactPreviewContent, { artifact: v1 }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("reviewing v1");
    expect(status.textContent).toContain("v2 is now latest");
    fireEvent.click(
      screen.getByRole("button", { name: "Compare with latest" }),
    );

    await screen.findByTestId("artifact-version-comparison");
    await waitFor(() => {
      expect(
        (screen.getByLabelText("From version") as HTMLSelectElement).value,
      ).toBe(v1.id);
      expect(
        (screen.getByLabelText("To version") as HTMLSelectElement).value,
      ).toBe(v2.id);
    });
  });
});

function artifactSummary(
  overrides: Partial<WorkspaceArtifactSummary>,
): WorkspaceArtifactSummary {
  const id = overrides.id ?? "artifact-v1";
  return {
    id,
    title: "Quarterly brief",
    filename: "quarterly-brief.md",
    kind: "markdown",
    mimeType: "text/markdown",
    sizeBytes: 40,
    source: "assistant-code-block",
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    artifactGroupId: "artifact-group-1",
    versionNumber: 1,
    supersedesArtifactId: null,
    versionSummary: null,
    metadata: {},
    createdAt: "2026-08-10T12:00:00.000Z",
    previewUrl: `/workspace/artifacts/${id}`,
    downloadUrl: `/api/workspace/artifacts/${id}/download`,
    ...overrides,
  };
}
