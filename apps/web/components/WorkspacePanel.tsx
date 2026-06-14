"use client";

import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import { useEffect, useState } from "react";

interface Props {
  onClose: () => void;
  onOpenSidebar: () => void;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
}

interface WorkspaceArtifactsResponse {
  artifacts: WorkspaceArtifactSummary[];
}

export function WorkspacePanel({
  onClose,
  onOpenSidebar,
  onOpenArtifact,
}: Props) {
  const [artifacts, setArtifacts] = useState<WorkspaceArtifactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  async function loadArtifacts() {
    setLoading(true);
    try {
      const res = await fetch("/api/workspace/artifacts");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WorkspaceArtifactsResponse;
      setArtifacts(data.artifacts ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadArtifacts();
  }, []);

  const artifactGroups = groupArtifacts(artifacts);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-canvas">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:bg-subtle hover:text-ink md:hidden"
        >
          <MenuIcon />
        </button>
        <h1 className="flex-1 truncate px-2 text-sm font-medium text-ink">
          Artifacts
        </h1>
        <button
          type="button"
          onClick={() => void loadArtifacts()}
          disabled={loading}
          className="mr-1 rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workspace"
          className="mr-2 flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
          <section className="border-b border-hairline pb-4">
            <h2 className="text-base font-semibold text-ink">Artifacts</h2>
            <p className="mt-1 text-[12px] text-muted">
              {artifactGroups.length} artifact{artifactGroups.length === 1 ? "" : "s"} ·{" "}
              {artifacts.length} version{artifacts.length === 1 ? "" : "s"}
            </p>
          </section>

          {error ? (
            <div className="rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-[13px] text-red-300">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-md border border-hairline px-4 py-6 text-center text-[13px] text-muted">
              Loading artifacts...
            </div>
          ) : artifactGroups.length === 0 ? (
            <div className="rounded-md border border-hairline px-4 py-6 text-center text-[13px] text-muted">
              No artifacts yet.
            </div>
          ) : (
            <div className="grid gap-2">
              {artifactGroups.map((group) => (
                <ArtifactGroupRow
                  key={group.groupId}
                  group={group}
                  onOpenArtifact={onOpenArtifact}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ArtifactGroup {
  groupId: string;
  latest: WorkspaceArtifactSummary;
  versions: WorkspaceArtifactSummary[];
}

function ArtifactGroupRow({
  group,
  onOpenArtifact,
}: {
  group: ArtifactGroup;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
}) {
  const { latest, versions } = group;
  const previousVersions = versions.slice(1);
  return (
    <details className="group rounded-md border border-hairline px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-3 marker:hidden">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-subtle text-[11px] font-semibold uppercase text-muted">
          {latest.kind.slice(0, 4)}
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              onOpenArtifact(latest);
            }}
            className="block max-w-full truncate text-left text-sm font-medium text-ink underline-offset-2 hover:underline"
          >
            {latest.title}
          </button>
          <p className="mt-0.5 truncate text-[12px] text-muted">
            {latest.filename} · v{latest.versionNumber} ·{" "}
            {formatBytes(latest.sizeBytes)} · {formatDate(latest.createdAt)}
          </p>
        </div>
        {versions.length > 1 ? (
          <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-muted">
            {versions.length} versions
          </span>
        ) : null}
        <a
          href={latest.downloadUrl}
          onClick={(event) => event.stopPropagation()}
          className="rounded-md border border-hairline px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle"
        >
          Download
        </a>
      </summary>
      {previousVersions.length > 0 ? (
        <div className="mt-2 border-t border-hairline pt-2">
          <div className="grid gap-1.5">
            {previousVersions.map((artifact) => (
              <div
                key={artifact.id}
                className="flex min-w-0 items-center gap-2 pl-12 text-[12px]"
              >
                <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  v{artifact.versionNumber}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenArtifact(artifact)}
                  className="min-w-0 flex-1 truncate text-left text-muted hover:text-ink hover:underline"
                >
                  {artifact.filename} · {formatDate(artifact.createdAt)}
                </button>
                <a
                  href={artifact.downloadUrl}
                  className="shrink-0 text-muted hover:text-ink"
                >
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function groupArtifacts(artifacts: WorkspaceArtifactSummary[]): ArtifactGroup[] {
  const byGroup = new Map<string, WorkspaceArtifactSummary[]>();
  for (const artifact of artifacts) {
    const key = artifact.artifactGroupId || artifact.id;
    const group = byGroup.get(key) ?? [];
    group.push(artifact);
    byGroup.set(key, group);
  }
  return Array.from(byGroup.entries())
    .map(([groupId, versions]) => {
      const sortedVersions = [...versions].sort(
        (a, b) => b.versionNumber - a.versionNumber,
      );
      return {
        groupId,
        versions: sortedVersions,
        latest: sortedVersions[0]!,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.latest.createdAt).getTime() -
        new Date(a.latest.createdAt).getTime(),
    );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
