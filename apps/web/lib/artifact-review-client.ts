import type { TextReviewAnchor } from "@/lib/artifact-diff";

export type ArtifactReviewAnchor =
  | { kind: "artifact" }
  | TextReviewAnchor;

export interface ArtifactReviewCommentView {
  id: string;
  artifactId: string | null;
  artifactGroupId: string;
  artifactVersionNumber: number;
  artifactFilename: string;
  body: string;
  anchor: ArtifactReviewAnchor;
  status: "open" | "addressing" | "addressed";
  revision: number;
  author: { id: string | null; displayName: string };
  addressingRunId: string | null;
  addressedAt: string | null;
  resultArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: {
    canEdit: boolean;
    canResolve: boolean;
    canReopen: boolean;
  };
}

export interface ArtifactReviewPermissions {
  canComment: boolean;
  canAddress: boolean;
}

export interface ArtifactReviewSelection {
  id: string;
  revision: number;
}

export function formatArtifactReviewMessage({
  filename,
  versionNumber,
  commentCount,
}: {
  filename: string;
  versionNumber: number;
  commentCount: number;
}): string {
  return `Address ${commentCount} review comment${commentCount === 1 ? "" : "s"} on ${filename} (v${versionNumber}).`;
}
