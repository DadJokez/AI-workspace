import { describe, expect, it } from "vitest";
import { getLinkedIssueTag } from "@/app/admin/feedback/issue-tags";

describe("getLinkedIssueTag", () => {
  it("extracts GitHub issue numbers", () => {
    expect(
      getLinkedIssueTag("https://github.com/DadJokez/AI-workspace/issues/240"),
    ).toEqual({ label: "#240", kind: "issue" });
  });

  it("extracts GitHub pull request numbers", () => {
    expect(
      getLinkedIssueTag("https://github.com/DadJokez/AI-workspace/pull/225"),
    ).toEqual({ label: "#225", kind: "pull" });
  });

  it("ignores non-GitHub or malformed URLs", () => {
    expect(getLinkedIssueTag("https://example.com/issues/240")).toBeNull();
    expect(getLinkedIssueTag("not a url")).toBeNull();
  });
});
