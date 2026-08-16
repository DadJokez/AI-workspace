"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

interface OwnerOption {
  id: string;
  label: string;
}

export function ConnectorControls({
  connector,
  owners,
}: {
  connector: {
    id: string;
    status: "active" | "disabled" | "planned";
    ownerUserId: string | null;
    credentialType: string | null;
    credentialTtlSeconds: number | null;
    lastRotatedAt: string | null;
  };
  owners: OwnerOption[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState(connector.status);
  const [ownerUserId, setOwnerUserId] = useState(connector.ownerUserId ?? "");
  const [credentialType, setCredentialType] = useState(connector.credentialType ?? "");
  const [ttlDays, setTtlDays] = useState(
    connector.credentialTtlSeconds
      ? String(connector.credentialTtlSeconds / 86_400)
      : "",
  );
  const [lastRotatedAt, setLastRotatedAt] = useState(
    connector.lastRotatedAt?.slice(0, 10) ?? "",
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const ttl = ttlDays.trim() ? Math.round(Number(ttlDays) * 86_400) : null;
      await fetchJson(
        `/api/admin/connectors/${connector.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status,
            ownerUserId: ownerUserId || null,
            credentialType: credentialType || null,
            credentialTtlSeconds: ttl,
            lastRotatedAt: lastRotatedAt || null,
            reason,
          }),
        },
        "The connector could not be updated.",
      );
      setMessage("Saved.");
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid min-w-[32rem] grid-cols-5 gap-2">
      <label className="text-2xs text-muted">
        State
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
        >
          <option value="active">active</option>
          <option value="disabled">disabled</option>
          <option value="planned">planned</option>
        </select>
      </label>
      <label className="text-2xs text-muted">
        Owner
        <select
          value={ownerUserId}
          onChange={(event) => setOwnerUserId(event.target.value)}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
        >
          <option value="">Unassigned</option>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-2xs text-muted">
        Credential
        <input
          value={credentialType}
          onChange={(event) => setCredentialType(event.target.value)}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
        />
      </label>
      <label className="text-2xs text-muted">
        TTL days
        <input
          type="number"
          min="0.0007"
          max="365"
          step="0.25"
          value={ttlDays}
          onChange={(event) => setTtlDays(event.target.value)}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
        />
      </label>
      <label className="text-2xs text-muted">
        Last rotated
        <input
          type="date"
          value={lastRotatedAt}
          onChange={(event) => setLastRotatedAt(event.target.value)}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
        />
      </label>
      <label className="col-span-4 text-2xs text-muted">
        Change reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={status === "active" ? "Optional" : "Required to disable"}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink placeholder:text-muted"
        />
      </label>
      <div className="flex items-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {message ? <span className="text-2xs text-muted">{message}</span> : null}
      </div>
    </div>
  );
}

export function ToolPolicyControls({
  tool,
}: {
  tool: {
    id: string;
    policy: "always_allow" | "needs_approval" | "blocked";
    enabled: boolean;
  };
}) {
  const router = useRouter();
  const [policy, setPolicy] = useState(tool.policy);
  const [enabled, setEnabled] = useState(tool.enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await fetchJson(
        `/api/admin/connectors/tools/${tool.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policy, enabled }),
        },
        "The tool policy could not be saved.",
      );
      setMessage("Saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-[20rem] items-center gap-2">
      <select
        aria-label="Tool policy"
        value={policy}
        onChange={(event) => setPolicy(event.target.value as typeof policy)}
        className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink"
      >
        <option value="always_allow">Always allow</option>
        <option value="needs_approval">Needs approval</option>
        <option value="blocked">Blocked</option>
      </select>
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink hover:bg-subtle disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
      {message ? <span className="text-2xs text-muted">{message}</span> : null}
    </div>
  );
}

export function ConnectionRevokeControl({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function revoke() {
    setSaving(true);
    setMessage(null);
    try {
      await fetchJson(
        `/api/admin/connectors/connections/${connectionId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        },
        "The connection could not be revoked.",
      );
      setMessage("Revoked.");
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Revocation failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-[18rem] items-center gap-2">
      <input
        aria-label="Revocation reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason"
        className="min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink placeholder:text-muted"
      />
      <button
        type="button"
        disabled={saving || reason.trim().length < 3}
        onClick={() => void revoke()}
        className="rounded-md border border-danger/30 px-2.5 py-1.5 text-xs text-danger hover:bg-danger-bg disabled:opacity-50"
      >
        {saving ? "Revoking..." : "Revoke"}
      </button>
      {message ? <span className="text-2xs text-muted">{message}</span> : null}
    </div>
  );
}
