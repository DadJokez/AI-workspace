import { randomUUID } from "node:crypto";

export interface WorkspaceArtifactVersionTarget {
  id: string;
  title: string;
  filename: string;
  artifactGroupId: string;
  versionNumber: number;
  metadata: Record<string, unknown> | null;
}

export interface PlannedArtifactVersion {
  artifactKey: string;
  artifactGroupId: string;
  versionNumber: number;
  supersedesArtifactId: string | null;
  filename: string;
  title?: string;
  versionSummary: string;
}

interface ArtifactVersionTargetSource {
  id: string;
  title: string;
  filename: string;
  artifactGroupId: string;
  versionNumber: number;
  metadata?: unknown;
}

interface ArtifactContextTargetPayload {
  text?: string;
  mode: "manifest" | "revision" | "separate";
  matchedArtifact: ArtifactVersionTargetSource | null;
}

interface ArtifactVersionCandidate {
  title: string;
  filename: string;
}

interface ArtifactVersionPrior {
  id: string;
  title: string;
  filename: string;
  artifactGroupId: string;
  versionNumber: number;
  metadata?: unknown;
}

export function toWorkspaceArtifactVersionTarget(
  artifact: ArtifactVersionTargetSource,
): WorkspaceArtifactVersionTarget {
  return {
    id: artifact.id,
    title: artifact.title,
    filename: artifact.filename,
    artifactGroupId: artifact.artifactGroupId,
    versionNumber: artifact.versionNumber,
    metadata: isRecord(artifact.metadata) ? artifact.metadata : null,
  };
}

export function parseWorkspaceArtifactVersionTarget(
  value: unknown,
): WorkspaceArtifactVersionTarget | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.filename !== "string" ||
    typeof value.artifactGroupId !== "string" ||
    typeof value.versionNumber !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    filename: value.filename,
    artifactGroupId: value.artifactGroupId,
    versionNumber: value.versionNumber,
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

export function resolveArtifactContextTargets({
  payload,
  storedArtifactTarget,
  storedSeparateFromArtifact,
}: {
  payload: ArtifactContextTargetPayload | null;
  storedArtifactTarget?: WorkspaceArtifactVersionTarget | null;
  storedSeparateFromArtifact?: WorkspaceArtifactVersionTarget | null;
}): {
  artifactContextTarget: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact: WorkspaceArtifactVersionTarget | null;
} {
  return {
    artifactContextTarget:
      payload?.mode === "revision" && payload.matchedArtifact
        ? toWorkspaceArtifactVersionTarget(payload.matchedArtifact)
        : storedArtifactTarget ?? null,
    separateFromArtifact:
      payload?.mode === "separate" && payload.matchedArtifact
        ? toWorkspaceArtifactVersionTarget(payload.matchedArtifact)
        : storedSeparateFromArtifact ?? null,
  };
}

export function planArtifactVersionsForExistingArtifacts<
  TArtifact extends ArtifactVersionCandidate,
>({
  artifacts,
  priorArtifacts,
  targetArtifact,
  separateFromArtifact,
}: {
  artifacts: readonly TArtifact[];
  priorArtifacts: readonly ArtifactVersionPrior[];
  targetArtifact?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
}): Array<{ artifact: TArtifact; version: PlannedArtifactVersion }> {
  const targetKey = targetArtifact
    ? artifactKeyFromArtifact(targetArtifact)
    : null;
  const latestByKey = new Map<string, ArtifactVersionPrior>();
  const latestTargetByKey = new Map<string, ArtifactVersionPrior>();

  for (const row of priorArtifacts) {
    const key = artifactKeyFromArtifact(row);
    if (row.artifactGroupId === targetArtifact?.artifactGroupId) {
      if (!latestTargetByKey.has(key)) latestTargetByKey.set(key, row);
      continue;
    }
    if (!latestByKey.has(key)) latestByKey.set(key, row);
  }

  if (targetArtifact && targetKey && !latestTargetByKey.has(targetKey)) {
    latestTargetByKey.set(targetKey, targetArtifact);
  }

  for (const [key, row] of latestTargetByKey) {
    latestByKey.set(key, row);
  }

  const planned: Array<{
    artifact: TArtifact;
    version: PlannedArtifactVersion;
  }> = [];

  for (const [index, artifact] of artifacts.entries()) {
    const parsedArtifactKey = artifactKeyFromFilename(artifact.filename);
    const separateFromKey = separateFromArtifact
      ? artifactKeyFromArtifact(separateFromArtifact)
      : null;
    const separateFilename =
      separateFromArtifact &&
      separateFromKey &&
      isCompatibleArtifactRevision(
        artifact.filename,
        separateFromArtifact.filename,
      ) &&
      (parsedArtifactKey === separateFromKey ||
        (artifacts.length === 1 &&
          isGenericRevisionFilename(artifact.filename)))
        ? filenameForSeparateCopy({
            emittedFilename: artifact.filename,
            sourceArtifact: separateFromArtifact,
            existingKeys: latestByKey,
          })
        : null;
    const useTarget =
      !separateFilename &&
      !!targetArtifact &&
      !!targetKey &&
      (parsedArtifactKey === targetKey ||
        (artifacts.length === 1 &&
          isCompatibleArtifactRevision(
            artifact.filename,
            targetArtifact.filename,
          ) &&
          !latestByKey.has(parsedArtifactKey)));
    const artifactKey = separateFilename
      ? artifactKeyFromVisibleFilename(separateFilename)
      : useTarget
        ? targetKey
        : parsedArtifactKey;
    const prior = separateFilename ? undefined : latestByKey.get(artifactKey);
    const versionNumber = prior ? prior.versionNumber + 1 : 1;
    const artifactGroupId = prior?.artifactGroupId ?? randomUUID();
    const existingArtifact = useTarget ? targetArtifact : prior;
    const filename =
      separateFilename ??
      (existingArtifact
        ? canonicalFilenameForArtifact(existingArtifact)
        : sanitizeArtifactFilename(artifact.filename));
    const version: PlannedArtifactVersion = {
      artifactKey,
      artifactGroupId,
      versionNumber,
      supersedesArtifactId: prior?.id ?? null,
      filename,
      ...(useTarget ? { title: targetArtifact.title } : {}),
      versionSummary:
        versionNumber === 1
          ? "Initial artifact created from chat."
          : `Version ${versionNumber} created from chat revision.`,
    };
    planned.push({ artifact, version });
    latestByKey.set(artifactKey, {
      id: `planned:${index + 1}`,
      title: version.title ?? artifact.title,
      artifactGroupId,
      versionNumber,
      filename,
      metadata: { artifactKey },
    });
  }

  return planned;
}

export function sanitizeArtifactFilename(filename: string): string {
  const base = filename.split(/[\\/]/).filter(Boolean).pop() ?? "artifact.txt";
  const clean = base
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return clean.includes(".") ? clean : `${clean || "artifact"}.txt`;
}

function artifactKeyFromArtifact(artifact: {
  filename: string;
  metadata?: unknown;
}): string {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  return typeof metadata?.artifactKey === "string"
    ? metadata.artifactKey
    : artifactKeyFromFilename(artifact.filename);
}

function artifactKeyFromFilename(filename: string): string {
  const clean = sanitizeArtifactFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  const ext = dot === -1 ? "" : clean.slice(dot + 1);
  const base = stem
    .replace(/(?:^|[-_. ])v(?:ersion)?[-_. ]?\d+$/i, "")
    .replace(/[-_. ]+\d+$/i, "")
    .replace(/[-_. ]+$/, "");
  return `${base || "artifact"}.${ext || "txt"}`;
}

function artifactKeyFromVisibleFilename(filename: string): string {
  const clean = sanitizeArtifactFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const ext = dot === -1 ? "txt" : clean.slice(dot + 1);
  return clean.includes(".") ? clean : `${clean}.${ext}`;
}

function filenameForSeparateCopy({
  emittedFilename,
  sourceArtifact,
  existingKeys,
}: {
  emittedFilename: string;
  sourceArtifact: Pick<ArtifactVersionPrior, "filename" | "metadata">;
  existingKeys: ReadonlyMap<string, unknown>;
}): string {
  const emitted = sanitizeArtifactFilename(emittedFilename);
  const source = canonicalFilenameForArtifact(sourceArtifact);
  const emittedKey = artifactKeyFromVisibleFilename(emitted);
  const sourceKey = artifactKeyFromVisibleFilename(source);
  if (
    emittedKey !== sourceKey &&
    !isGenericRevisionFilename(emitted) &&
    !existingKeys.has(emittedKey)
  ) {
    return emitted;
  }

  const dot = source.lastIndexOf(".");
  const stem = dot === -1 ? source : source.slice(0, dot);
  const ext = dot === -1 ? "" : source.slice(dot);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? "copy" : `copy-${i}`;
    const candidate = `${stem}-${suffix}${ext}`;
    if (!existingKeys.has(artifactKeyFromVisibleFilename(candidate))) {
      return candidate;
    }
  }
  return `${stem}-copy-${Date.now()}${ext}`;
}

function isGenericRevisionFilename(filename: string): boolean {
  const clean = sanitizeArtifactFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  return /^(?:updated|revised|revision|artifact|file|document|output|result)(?:[-_ ]?\d+)?$/.test(
    stem,
  );
}

function canonicalFilenameForArtifact(artifact: { filename: string }): string {
  return filenameWithoutVisibleVersionSuffix(artifact.filename);
}

function filenameWithoutVisibleVersionSuffix(filename: string): string {
  const clean = sanitizeArtifactFilename(filename);
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  const ext = dot === -1 ? "" : clean.slice(dot);
  const base = stem
    .replace(/(?:^|[-_. ])v(?:ersion)?[-_. ]?\d+$/i, "")
    .replace(/[-_. ]+$/, "");
  return `${base || "artifact"}${ext}`;
}

function isCompatibleArtifactRevision(
  emittedFilename: string,
  targetFilename: string,
): boolean {
  return (
    normalizedExtension(emittedFilename) === normalizedExtension(targetFilename)
  );
}

function normalizedExtension(filename: string): string {
  const ext =
    sanitizeArtifactFilename(filename).split(".").pop()?.toLowerCase() ??
    "txt";
  if (ext === "htm") return "html";
  if (ext === "markdown") return "md";
  return ext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
