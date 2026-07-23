"use client";

import { useState } from "react";

export function WebEgressPolicyForm({
  initialDeniedDomains,
}: {
  initialDeniedDomains: readonly string[];
}) {
  const [value, setValue] = useState(initialDeniedDomains.join("\n"));
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const deniedDomains = value
        .split(/\r?\n|,/)
        .map((domain) => domain.trim())
        .filter(Boolean);
      const response = await fetch("/api/admin/web-egress-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deniedDomains }),
      });
      const body = (await response.json()) as {
        policy?: { deniedDomains?: string[] };
        message?: string;
      };
      if (!response.ok || !body.policy) {
        setStatus(body.message ?? "The policy could not be saved.");
        return;
      }
      const normalized = body.policy.deniedDomains ?? [];
      setValue(normalized.join("\n"));
      setStatus("Saved.");
    } catch {
      setStatus("The policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-y border-hairline px-6 py-4">
      <div className="max-w-3xl">
        <h3 className="text-sm font-semibold text-ink">Web egress policy</h3>
        <p className="mt-1 text-xs text-muted">
          Block direct and redirected fetches to these domains and all of
          their subdomains. Enter one domain per line.
        </p>
        <textarea
          aria-label="Denied web domains"
          className="mt-3 min-h-28 w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-xs text-ink placeholder:text-muted"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setStatus(null);
          }}
          placeholder={"example.com\ntracking.example.net"}
          spellCheck={false}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save policy"}
          </button>
          {status ? (
            <span className="text-xs text-muted" role="status">
              {status}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
