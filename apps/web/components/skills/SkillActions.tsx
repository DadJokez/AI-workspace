"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

interface SkillActionsProps {
  skillId: string;
  isOwner: boolean;
  showArchive?: boolean;
}

/**
 * Run / Clone / Archive controls for a skill. Run navigates to the thread
 * the run streams into; provider-gating 409s surface as actionable text
 * instead of a silent failure.
 */
export function SkillActions({
  skillId,
  isOwner,
  showArchive = false,
}: SkillActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"run" | "clone" | "archive" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleRun() {
    setBusy("run");
    setNotice(null);
    try {
      const body = await fetchJson<{
        threadId?: string;
      }>(
        `/api/skills/${skillId}/run`,
        { method: "POST" },
        "The skill could not be run.",
      );
      if (!body.threadId) {
        throw new Error("The skill started without a chat ID.");
      }
      router.push(`/chat?threadId=${body.threadId}`);
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "The skill could not be run.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleClone() {
    setBusy("clone");
    setNotice(null);
    try {
      const body = await fetchJson<{
        skill?: { id: string };
      }>(
        `/api/skills/${skillId}/clone`,
        { method: "POST" },
        "The skill could not be cloned.",
      );
      if (!body.skill) {
        throw new Error("The skill was cloned without a skill ID.");
      }
      router.push(`/skills/${body.skill.id}`);
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "The skill could not be cloned.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive() {
    if (!window.confirm("Archive this skill? Run history is kept.")) return;
    setBusy("archive");
    setNotice(null);
    try {
      await fetchJson(
        `/api/skills/${skillId}`,
        { method: "DELETE" },
        "The skill could not be archived.",
      );
      router.push("/skills");
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "The skill could not be archived.",
      );
    } finally {
      setBusy(null);
    }
  }

  const buttonClass =
    "rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-ink/5 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${buttonClass} font-medium`}
          onClick={handleRun}
          disabled={busy !== null}
        >
          {busy === "run" ? "Starting…" : "Run"}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={handleClone}
          disabled={busy !== null}
        >
          {busy === "clone" ? "Cloning…" : "Clone"}
        </button>
        {showArchive && isOwner ? (
          <button
            type="button"
            className={`${buttonClass} text-muted`}
            onClick={handleArchive}
            disabled={busy !== null}
          >
            {busy === "archive" ? "Archiving…" : "Archive"}
          </button>
        ) : null}
      </div>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
