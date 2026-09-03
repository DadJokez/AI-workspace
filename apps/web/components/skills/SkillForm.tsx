"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/client-api";
import { modelDisplayName } from "@/lib/model-display";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";

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

interface OAuthProviderDetail {
  connected?: boolean;
  toolAvailable?: boolean;
  status?: string;
}

interface OAuthStatusPayload extends Record<string, unknown> {
  providerDetails?: Record<string, OAuthProviderDetail>;
}

type ConnectionLoadState = "loading" | "loaded" | "failed";

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
  const [connectionState, setConnectionState] = useState<ConnectionLoadState>(
    "loading",
  );
  const [oauthStatus, setOauthStatus] = useState<OAuthStatusPayload>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/oauth/status", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data === "object") {
          setOauthStatus(data as OAuthStatusPayload);
          setConnectionState("loaded");
        } else {
          setConnectionState("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setConnectionState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const body = await fetchJson<{
        skill?: { id: string };
      }>(
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
        "The skill could not be saved.",
      );
      if (!body.skill) {
        throw new Error("The skill was saved without a skill ID.");
      }
      router.push(`/skills/${body.skill.id}`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The skill could not be saved.",
      );
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
        {modelOptions.length > 1 ? (
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
                  {modelDisplayName(id)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="min-w-[280px] flex-1">
          <span className={labelClass}>Tools</span>
          <div className="mt-2 flex flex-col gap-2">
            {providerOptions.map((provider) => {
              const connection = providerConnection(
                provider,
                connectionState,
                oauthStatus,
              );
              return (
                <div
                  key={provider}
                  className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline pb-2 last:border-b-0"
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={form.mcpProviders.includes(provider)}
                      onChange={() => toggleProvider(provider)}
                    />
                    {providerDisplayName(provider)}
                  </label>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`flex items-center gap-1.5 ${connection.textClass}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${connection.dotClass}`}
                      />
                      {connection.label}
                    </span>
                    {connection.showConnectLink ? (
                      <Link
                        href="/chat?open=settings&section=integrations"
                        className="text-ink underline underline-offset-2 hover:text-muted"
                      >
                        Connect in Settings
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
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

function providerDisplayName(provider: string): string {
  if (provider === "web") return "Web access";
  return (
    INTEGRATION_DISPLAY_NAMES[
      provider as keyof typeof INTEGRATION_DISPLAY_NAMES
    ] ?? "Work tool"
  );
}

function providerConnection(
  provider: string,
  loadState: ConnectionLoadState,
  status: OAuthStatusPayload,
) {
  if (provider === "web") {
    return {
      label: "Built in",
      textClass: "text-muted",
      dotClass: "bg-success",
      showConnectLink: false,
    };
  }
  if (loadState === "loading") {
    return {
      label: "Checking connection…",
      textClass: "text-muted",
      dotClass: "bg-muted",
      showConnectLink: false,
    };
  }

  const detail = status.providerDetails?.[provider];
  const connected = detail?.connected === true || status[provider] === true;
  if (detail?.status === "reconnect_required") {
    return {
      label: "Reconnect required",
      textClass: "text-warning",
      dotClass: "bg-warning",
      showConnectLink: true,
    };
  }
  if (connected && detail?.toolAvailable !== false) {
    return {
      label: "Connected",
      textClass: "text-success",
      dotClass: "bg-success",
      showConnectLink: false,
    };
  }
  if (connected) {
    return {
      label: "Unavailable",
      textClass: "text-warning",
      dotClass: "bg-warning",
      showConnectLink: true,
    };
  }
  return {
    label: loadState === "failed" ? "Connection unknown" : "Not connected",
    textClass: "text-muted",
    dotClass: "bg-muted",
    showConnectLink: true,
  };
}
