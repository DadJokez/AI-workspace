export interface AppDraftVersionSummary {
  id: string;
  appId: string;
  appName: string;
  appSlug: string;
  artifactId: string;
  versionNumber: number;
  status:
    | "draft"
    | "proposed"
    | "iterating"
    | "deployed"
    | "reverted"
    | "discarded"
    | "superseded";
  canDeploy: boolean;
  previewUrl: string;
  liveUrl: string;
}

export function parseAppDraftVersionSummaries(
  value: unknown,
): AppDraftVersionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.appId !== "string" ||
      typeof candidate.appName !== "string" ||
      typeof candidate.appSlug !== "string" ||
      typeof candidate.artifactId !== "string" ||
      typeof candidate.versionNumber !== "number" ||
      !Number.isInteger(candidate.versionNumber) ||
      candidate.versionNumber < 1 ||
      !isAppDraftVersionStatus(candidate.status) ||
      typeof candidate.canDeploy !== "boolean" ||
      typeof candidate.previewUrl !== "string" ||
      typeof candidate.liveUrl !== "string"
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        appId: candidate.appId,
        appName: candidate.appName,
        appSlug: candidate.appSlug,
        artifactId: candidate.artifactId,
        versionNumber: candidate.versionNumber,
        status: candidate.status,
        canDeploy: candidate.canDeploy,
        previewUrl: candidate.previewUrl,
        liveUrl: candidate.liveUrl,
      },
    ];
  });
}

export function latestAppDraftVersionIds(
  versions: readonly AppDraftVersionSummary[],
): Set<string> {
  const latestByApp = new Map<string, AppDraftVersionSummary>();
  const visible = new Set(
    versions
      .filter((version) => version.status === "superseded")
      .map((version) => version.id),
  );
  for (const version of versions) {
    const current = latestByApp.get(version.appId);
    if (!current || version.versionNumber > current.versionNumber) {
      latestByApp.set(version.appId, version);
    }
  }
  for (const version of latestByApp.values()) visible.add(version.id);
  return visible;
}

export function markAppDraftVersionDeployed(
  versions: readonly AppDraftVersionSummary[],
  deployedVersionId: string,
  liveUrl?: string,
): AppDraftVersionSummary[] {
  const deployed = versions.find((version) => version.id === deployedVersionId);
  if (!deployed) return [...versions];
  return versions.map((version) => {
    if (version.appId !== deployed.appId) return version;
    if (version.id === deployedVersionId) {
      return {
        ...version,
        status: "deployed",
        canDeploy: false,
        liveUrl: liveUrl ?? version.liveUrl,
      };
    }
    return version.status === "deployed"
      ? { ...version, status: "reverted" }
      : version;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAppDraftVersionStatus(
  value: unknown,
): value is AppDraftVersionSummary["status"] {
  return (
    value === "draft" ||
    value === "proposed" ||
    value === "iterating" ||
    value === "deployed" ||
    value === "reverted" ||
    value === "discarded" ||
    value === "superseded"
  );
}
