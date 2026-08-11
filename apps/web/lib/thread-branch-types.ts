export const THREAD_BRANCH_SOURCE_TYPES = [
  "message",
  "thread",
  "artifact",
  "app_version",
  "proposal",
] as const;

export type ThreadBranchSourceType =
  (typeof THREAD_BRANCH_SOURCE_TYPES)[number];

export interface ThreadBranchRequest {
  sourceType: ThreadBranchSourceType;
  sourceThreadId?: string;
  sourceMessageId?: string;
  artifactId?: string;
  appVersionId?: string;
}

export interface ThreadBranchLineageResource {
  artifactIdSnapshot: string;
  artifactId?: string;
  messageId?: string | null;
  title: string;
  filename: string;
  kind: string;
  versionNumber: number;
  appVersionIdSnapshot?: string;
  proposalStatus?: string;
  status: "available" | "unavailable";
}

export interface ThreadBranchLineage {
  sourceType: ThreadBranchSourceType;
  sourceTitle: string;
  parentThreadId: string | null;
  parentThreadIdSnapshot: string | null;
  branchPointMessageId: string | null;
  branchPointMessageIdSnapshot: string | null;
  sourceArtifactId: string | null;
  sourceArtifactIdSnapshot: string | null;
  sourceAppVersionId: string | null;
  sourceAppVersionIdSnapshot: string | null;
  messageCount: number;
  resources: ThreadBranchLineageResource[];
  createdAt: string;
}

export interface ThreadAlternativeLink {
  threadId: string;
  title: string;
  sourceType: ThreadBranchSourceType;
  createdAt: string;
}

export interface ThreadBranchResponse {
  thread: {
    id: string;
    title: string | null;
    defaultModelId: string;
    createdAt: string;
    updatedAt: string;
  };
  lineage: ThreadBranchLineage;
  url: string;
}
