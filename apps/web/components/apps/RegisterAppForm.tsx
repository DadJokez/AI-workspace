"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDate } from "@/lib/format-date";

interface ArtifactOption {
  id: string;
  title: string;
  filename: string;
  createdAt: string;
  hasDataBindings: boolean;
}

/** Pick an HTML artifact, name it, publish it as a workspace app. */
export function RegisterAppForm({ artifacts }: { artifacts: ArtifactOption[] }) {
  const router = useRouter();
  const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [dataMode, setDataMode] = useState<
    "snapshot" | "live_via_viewer"
  >("snapshot");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (artifacts.length === 0) {
    return (
      <p className="rounded-md border border-hairline px-3 py-3 text-xs text-muted">
        No HTML artifacts yet — ask the assistant to build a page in chat
        first.
      </p>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId, name, dataMode }),
      });
      const body = (await res.json()) as {
        app?: { id: string };
        message?: string;
        error?: string;
      };
      if (res.ok && body.app) {
        router.push(`/apps/manage/${body.app.id}`);
        router.refresh();
        return;
      }
      setNotice(body.message ?? body.error ?? "Could not publish the app.");
    } catch {
      setNotice("Could not publish the app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Artifact
        <select
          className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
          value={artifactId}
          onChange={(e) => {
            setArtifactId(e.target.value);
            const next = artifacts.find(
              (artifact) => artifact.id === e.target.value,
            );
            if (!next?.hasDataBindings) setDataMode("snapshot");
          }}
        >
          {artifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.id}>
              {artifact.title} · {artifact.filename} ·{" "}
              {formatDate(artifact.createdAt)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-muted">Data mode</legend>
        <div className="inline-flex w-fit rounded-md border border-hairline p-0.5">
          <label
            className={`cursor-pointer rounded px-2.5 py-1 text-xs ${
              dataMode === "snapshot"
                ? "bg-ink text-canvas"
                : "text-muted hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name="dataMode"
              value="snapshot"
              checked={dataMode === "snapshot"}
              onChange={() => setDataMode("snapshot")}
              className="sr-only"
            />
            Snapshot
          </label>
          <label
            title={
              artifacts.find((artifact) => artifact.id === artifactId)
                ?.hasDataBindings
                ? "Refreshes with each viewer's own connected account."
                : "This artifact has no supported live data binding."
            }
            className={`rounded px-2.5 py-1 text-xs ${
              artifacts.find((artifact) => artifact.id === artifactId)
                ?.hasDataBindings
                ? "cursor-pointer"
                : "cursor-not-allowed opacity-40"
            } ${
              dataMode === "live_via_viewer"
                ? "bg-ink text-canvas"
                : "text-muted hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name="dataMode"
              value="live_via_viewer"
              checked={dataMode === "live_via_viewer"}
              disabled={
                !artifacts.find((artifact) => artifact.id === artifactId)
                  ?.hasDataBindings
              }
              onChange={() => setDataMode("live_via_viewer")}
              className="sr-only"
            />
            Live via viewer
          </label>
        </div>
        <p className="text-xs text-muted">
          {dataMode === "snapshot"
            ? "Publishes the current data exactly as shown."
            : "Refreshes under each viewer's own connected account."}
        </p>
      </fieldset>
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          App name
          <input
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team briefing dashboard"
            required
            maxLength={120}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !artifactId}
          className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </form>
  );
}
