export interface LinkedIssueTag {
  label: string;
  kind: "issue" | "pull";
}

export function getLinkedIssueTag(value: string | null): LinkedIssueTag | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;

    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex(
      (part) => part === "issues" || part === "pull",
    );
    const number = markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
    if (!number || !/^\d+$/.test(number)) return null;

    return {
      label: `#${number}`,
      kind: parts[markerIndex] === "pull" ? "pull" : "issue",
    };
  } catch {
    return null;
  }
}
