"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface VersionRow {
  artifactId: string;
  title: string;
  filename: string;
  createdAt: string;
  isLive: boolean;
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
}: {
  appId: string;
  versions: VersionRow[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function deployVersion(artifactId: string) {
    setBusyId(artifactId);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/${appId}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId }),
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

  if (versions.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        No versions found. Keep iterating in the app&apos;s source
        conversation — every HTML artifact it produces appears here.
      </p>
    );
  }

  const liveIndex = versions.findIndex((v) => v.isLive);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {versions.map((version, index) => (
          <li
            key={version.artifactId}
            className="flex items-center justify-between rounded-md border border-hairline px-3 py-2 text-[12px]"
          >
            <span className="min-w-0 truncate text-ink">
              {version.title}
              <span className="text-muted">
                {" "}
                · {new Date(version.createdAt).toLocaleString()}
              </span>
              {version.isLive ? (
                <span className="ml-2 rounded bg-ink/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink">
                  Live
                </span>
              ) : null}
            </span>
            {!version.isLive ? (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => deployVersion(version.artifactId)}
                className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
              >
                {busyId === version.artifactId
                  ? "Deploying…"
                  : liveIndex !== -1 && index > liveIndex
                    ? "Revert to this"
                    : "Deploy"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {notice ? <p className="text-[12px] text-muted">{notice}</p> : null}
    </div>
  );
}
