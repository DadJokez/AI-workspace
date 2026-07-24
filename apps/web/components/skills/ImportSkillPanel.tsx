"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

/**
 * Paste a SKILL.md (ADR 0002) and create a skill from it — the direct path
 * for the Skill Creator's output, or any Anthropic-format skill.
 */
export function ImportSkillPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    setBusy(true);
    setError(null);
    try {
      const body = await fetchJson<{
        skill?: { id: string };
      }>(
        "/api/skills/import",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markdown }),
        },
        "Could not import that SKILL.md.",
      );
      if (!body.skill) {
        throw new Error("The skill was imported without a skill ID.");
      }
      router.push(`/skills/${body.skill.id}`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not import that SKILL.md.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline hover:text-ink"
      >
        Import from SKILL.md instead
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink">
          Import a SKILL.md
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted hover:text-ink"
        >
          Use the form instead
        </button>
      </div>
      <p className="text-2xs text-muted">
        Paste a SKILL.md (YAML frontmatter + instructions). The Skill Creator
        skill produces these.
      </p>
      <textarea
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        rows={10}
        placeholder={"---\nname: my-skill\ndescription: what it does and when to use it\nmodel: sonnet-4-5\nmcp_providers: []\n---\nYou ..."}
        className="w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-xs text-ink placeholder:text-muted"
      />
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <button
        type="button"
        disabled={busy || !markdown.trim()}
        onClick={handleImport}
        className="self-start rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import skill"}
      </button>
    </div>
  );
}
