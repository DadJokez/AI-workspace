// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactPreviewContent,
  revealTextRangeWithin,
  selectionOffsetsWithin,
} from "@/components/ArtifactPreviewPane";
import { createTextReviewAnchor } from "@/lib/artifact-diff";
import type { ArtifactReviewCommentView } from "@/lib/artifact-review-client";
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
let reviewComments: ArtifactReviewCommentView[];
let reviewRequests: Array<{ method: string; path: string; body: unknown }>;

beforeEach(() => {
  reviewComments = [];
  reviewRequests = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/review-comments")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as {
            body: string;
            anchor: ArtifactReviewCommentView["anchor"];
          };
          reviewRequests.push({ method, path, body });
          const comment = reviewComment({
            id: `comment-${reviewComments.length + 1}`,
            body: body.body,
            anchor: body.anchor,
          });
          reviewComments = [...reviewComments, comment];
          return Response.json({ comment }, { status: 201 });
        }
        return Response.json({
          artifactId: v2.id,
          artifactVersionNumber: v2.versionNumber,
          permissions: { canComment: true, canAddress: true },
          comments: reviewComments,
        });
      }
      if (path.includes("/review-comments/")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reviewRequests.push({ method, path, body });
        const id = path.split("/").at(-1);
        const current = reviewComments.find((comment) => comment.id === id)!;
        const comment = {
          ...current,
          ...(typeof body.body === "string" ? { body: body.body } : {}),
          ...(body.status === "open" || body.status === "addressed"
            ? { status: body.status }
            : {}),
          revision: current.revision + 1,
        } as ArtifactReviewCommentView;
        reviewComments = reviewComments.map((item) =>
          item.id === comment.id ? comment : item,
        );
        return Response.json({ comment });
      }
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

  it("persists an exact source selection as an anchored comment", async () => {
    render(createElement(ArtifactPreviewContent, { artifact: v2 }));

    fireEvent.click(await screen.findByRole("tab", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    const source = await screen.findByTestId("artifact-source-view");
    const sourceText = source.firstChild!;
    const start = source.textContent!.indexOf("New line");
    const range = document.createRange();
    range.setStart(sourceText, start);
    range.setEnd(sourceText, start + "New line".length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    fireEvent.click(screen.getByRole("button", { name: "Comment selection" }));
    expect(screen.getByText("“New line”")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add comment"), {
      target: { value: "Make this more specific." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() => expect(reviewRequests).toHaveLength(1));
    expect(reviewRequests[0]).toMatchObject({
      method: "POST",
      body: {
        body: "Make this more specific.",
        anchor: {
          kind: "text-range",
          startOffset: start,
          endOffset: start + "New line".length,
          quote: "New line",
        },
      },
    });
  });

  it("reopens a deep-linked anchor and addresses only selected open comments", async () => {
    const source = details[v2.id]!.content;
    const start = source.indexOf("New line");
    reviewComments = [
      reviewComment({
        id: "comment-focus",
        body: "Use the approved launch language.",
        anchor: createTextReviewAnchor(
          source,
          start,
          start + "New line".length,
        ),
      }),
      reviewComment({
        id: "comment-other",
        body: "Unselected feedback.",
        author: { id: "reviewer-2", displayName: "Jordan Reviewer" },
      }),
    ];
    const onAddressComments = vi.fn(async () => true);

    render(
      createElement(ArtifactPreviewContent, {
        artifact: v2,
        focusReviewCommentId: "comment-focus",
        onAddressComments,
      }),
    );

    await screen.findByTestId("artifact-source-view");
    await waitFor(() => expect(window.getSelection()?.toString()).toBe("New line"));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select comment by Avery Reviewer",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Address with Comparative (1)" }),
    );

    await waitFor(() =>
      expect(onAddressComments).toHaveBeenCalledWith([
        { id: "comment-focus", revision: 4 },
      ]),
    );
  });
});

describe("source range helpers", () => {
  it("round-trips offsets across multiple text nodes", () => {
    const element = document.createElement("pre");
    element.append("Alpha ");
    const strong = document.createElement("strong");
    strong.textContent = "review this";
    element.append(strong, " Omega");
    document.body.append(element);

    expect(revealTextRangeWithin(element, 6, 17)).toBe(true);
    expect(window.getSelection()?.toString()).toBe("review this");
    expect(selectionOffsetsWithin(element)).toEqual({
      startOffset: 6,
      endOffset: 17,
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

function reviewComment(
  overrides: Partial<ArtifactReviewCommentView> = {},
): ArtifactReviewCommentView {
  return {
    id: "comment-1",
    artifactId: v2.id,
    artifactGroupId: v2.artifactGroupId,
    artifactVersionNumber: v2.versionNumber,
    artifactFilename: v2.filename,
    body: "Tighten this section.",
    anchor: { kind: "artifact" },
    status: "open",
    revision: 4,
    author: { id: "reviewer-1", displayName: "Avery Reviewer" },
    addressingRunId: null,
    addressedAt: null,
    resultArtifactId: null,
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    permissions: { canEdit: true, canResolve: true, canReopen: false },
    ...overrides,
  };
}
