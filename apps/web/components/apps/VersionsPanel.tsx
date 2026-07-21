"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface VersionRow {
  appVersionId: string;
  artifactId: string;
  versionNumber: number;
  status: string;
  summary: string | null;
  title: string;
  filename: string;
  createdAt: string;
  deployedAt: string | null;
  createdByName: string;
  isLive: boolean;
  canDeploy: boolean;
  canDiscard: boolean;
  previewUrl: string;
}

/**
 * "Previous versions", not git log: every HTML artifact from the app's
 * source conversation is a deployable version. Deploy promotes, Revert
 * repins — same button, plain language.
 */
export function VersionsPanel({
  appId,
  versions,
  canDeploy,
}: {
  appId: string;
  versions: VersionRow[];
  canDeploy: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function deployVersion(appVersionId: string) {
    setBusyId(appVersionId);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/${appId}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appVersionId }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (res.ok) {
        router.refresh();
        return;
      }
      setNotice(body.message ?? body.error ?? "Could not deploy this version.");
    } catch {
      setNotice("Could not deploy this version.");
    } finally {
      setBusyId(null);
    }
  }

  async function discardVersion(appVersionId: string) {
    setBusyId(appVersionId);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/${appId}/versions/${appVersionId}`, {
        method: "DELETE",
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (res.ok) {
        router.refresh();
        return;
      }
      setNotice(body.message ?? body.error ?? "Could not discard this draft.");
    } catch {
      setNotice("Could not discard this draft.");
    } finally {
      setBusyId(null);
    }
  }

  if (versions.length === 0) {
    return (
      <p className="text-xs text-muted">
        No versions found yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {versions.map((version) => (
          <li
            key={version.appVersionId}
            className="flex items-start justify-between gap-3 rounded-md border border-hairline px-3 py-2 text-xs"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-ink">
                <span className="font-medium">v{version.versionNumber}</span>
                <span className="truncate">{version.title}</span>
                {version.isLive ? (
                  <span className="rounded bg-ink/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-ink">
                    Live
                  </span>
                ) : (
                  <span className="rounded bg-ink/5 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
                    {version.status === "draft" ? "Draft" : "Previous"}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-muted">
                {version.filename} · {version.createdByName} ·{" "}
                {new Date(version.createdAt).toLocaleString()}
              </p>
              {version.summary ? (
                <p className="mt-1 text-muted">{version.summary}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={version.previewUrl}
                className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-ink/5"
              >
                Preview
              </a>
              {canDeploy && version.canDeploy ? (
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => deployVersion(version.appVersionId)}
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
                >
                  {busyId === version.appVersionId
                    ? "Deploying..."
                    : version.status === "draft"
                      ? "Deploy"
                      : "Rollback"}
                </button>
              ) : null}
              {version.canDiscard ? (
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => discardVersion(version.appVersionId)}
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
                >
                  Discard
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
