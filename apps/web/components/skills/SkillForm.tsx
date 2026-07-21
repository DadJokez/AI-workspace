"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SkillFormProps {
  mode: "create" | "edit";
  skillId?: string;
  modelOptions: string[];
  providerOptions: string[];
  initial?: {
    name: string;
    description: string;
    systemPrompt: string;
    modelId: string;
    mcpProviders: string[];
  };
}

const EMPTY = {
  name: "",
  description: "",
  systemPrompt: "",
  modelId: "",
  mcpProviders: [] as string[],
};

export function SkillForm({
  mode,
  skillId,
  modelOptions,
  providerOptions,
  initial,
}: SkillFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(
    initial ?? { ...EMPTY, modelId: modelOptions[0] ?? "" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleProvider(provider: string) {
    setForm((prev) => ({
      ...prev,
      mcpProviders: prev.mcpProviders.includes(provider)
        ? prev.mcpProviders.filter((p) => p !== provider)
        : [...prev.mcpProviders, provider],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        mode === "create" ? "/api/skills" : `/api/skills/${skillId}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            description: form.description || null,
            systemPrompt: form.systemPrompt,
            modelId: form.modelId,
            mcpProviders: form.mcpProviders,
          }),
        },
      );
      const body = (await res.json()) as {
        skill?: { id: string };
        message?: string;
        error?: string;
      };
      if (res.ok && body.skill) {
        router.push(`/skills/${body.skill.id}`);
        router.refresh();
        return;
      }
      setError(body.message ?? body.error ?? "The skill could not be saved.");
    } catch {
      setError("The skill could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted";
  const labelClass = "block text-xs font-medium text-muted";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label className={labelClass} htmlFor="skill-name">
          Name
        </label>
        <input
          id="skill-name"
          className={`mt-1 ${inputClass}`}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Morning Briefing"
          maxLength={120}
          required
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="skill-description">
          Description
        </label>
        <input
          id="skill-description"
          className={`mt-1 ${inputClass}`}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What does this skill do, and for whom?"
          maxLength={2000}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="skill-instructions">
          Instructions
        </label>
        <textarea
          id="skill-instructions"
          className={`mt-1 min-h-[200px] ${inputClass}`}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          placeholder="Tell the agent exactly what to do when this skill runs…"
          required
        />
      </div>

      <div className="flex flex-wrap gap-6">
        <div>
          <label className={labelClass} htmlFor="skill-model">
            Model
          </label>
          <select
            id="skill-model"
            className={`mt-1 ${inputClass}`}
            value={form.modelId}
            onChange={(e) => setForm({ ...form, modelId: e.target.value })}
          >
            {modelOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className={labelClass}>Tools</span>
          <div className="mt-2 flex flex-wrap gap-3">
            {providerOptions.map((provider) => (
              <label
                key={provider}
                className="flex items-center gap-2 text-sm text-ink"
              >
                <input
                  type="checkbox"
                  checked={form.mcpProviders.includes(provider)}
                  onChange={() => toggleProvider(provider)}
                />
                {provider}
              </label>
            ))}
            {providerOptions.length === 0 ? (
              <span className="text-xs text-muted">
                No tool providers available yet.
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create skill"
              : "Save changes"}
        </button>
      </div>
    </form>
  );
}
