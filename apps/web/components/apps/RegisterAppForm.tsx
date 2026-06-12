"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ArtifactOption {
  id: string;
  title: string;
  filename: string;
  createdAt: string;
}

/** Pick an HTML artifact, name it, deploy it as a workspace app. */
export function RegisterAppForm({ artifacts }: { artifacts: ArtifactOption[] }) {
  const router = useRouter();
  const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (artifacts.length === 0) {
    return (
      <p className="rounded-md border border-hairline px-3 py-3 text-[12px] text-muted">
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
        body: JSON.stringify({ artifactId, name }),
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
      setNotice(body.message ?? body.error ?? "Could not deploy the app.");
    } catch {
      setNotice("Could not deploy the app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Artifact
        <select
          className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
          value={artifactId}
          onChange={(e) => setArtifactId(e.target.value)}
        >
          {artifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.id}>
              {artifact.title} · {artifact.filename} ·{" "}
              {new Date(artifact.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted">
          App name
          <input
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
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
          className="rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busy ? "Deploying…" : "Deploy"}
        </button>
      </div>
      {notice ? <p className="text-[12px] text-muted">{notice}</p> : null}
    </form>
  );
}
