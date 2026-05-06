"use client";

import { useState } from "react";
import type { AdminInvitationRow } from "@/lib/invitations";

interface Props {
  initialInvitations: AdminInvitationRow[];
}

type Role = "admin" | "user";

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const day = 24 * 60 * 60 * 1000;
  if (ms >= day) {
    const d = Math.floor(ms / day);
    return d === 1 ? "1 day" : `${d} days`;
  }
  const h = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return h === 1 ? "1 hour" : `${h} hours`;
}

export function InvitePanel({ initialInvitations }: Props) {
  const [rows, setRows] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [lastUrl, setLastUrl] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        inviteUrl: string;
        invitation: AdminInvitationRow;
      };
      setRows((rs) => [body.invitation, ...rs]);
      setLastUrl(body.inviteUrl);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function copy(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === id ? undefined : cur));
      }, 1500);
    } catch {
      // Clipboard blocked (e.g. insecure origin). Falling back to a select-all
      // hint in the UI is overkill — the user can still copy out of the
      // visible input field.
    }
  }

  return (
    <div className="px-6 pb-6">
      <div className="rounded-md border border-hairline bg-canvas">
        <div className="border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Invite a teammate</h2>
          <p className="mt-1 text-[12px] text-muted">
            Generates a one-time link. Send it to the invitee — when they sign
            in, they get the role you assign here. Links expire after 7 days.
          </p>
        </div>
        <form
          onSubmit={submit}
          className="flex flex-wrap items-end gap-3 px-4 py-3"
        >
          <label className="flex flex-1 min-w-[240px] flex-col gap-1 text-[12px] text-muted">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-[13px] text-ink placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Generating…" : "Generate link"}
          </button>
          {error ? (
            <span className="text-[12px] text-red-400">{error}</span>
          ) : null}
        </form>
        {lastUrl ? (
          <div className="border-t border-hairline px-4 py-3">
            <div className="text-[12px] text-muted">
              New invite link — copy and share it now:
            </div>
            <div className="mt-1.5 flex gap-2">
              <input
                readOnly
                value={lastUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-md border border-hairline bg-subtle px-2 py-1.5 font-mono text-[12px] text-ink focus:outline-none"
              />
              <button
                type="button"
                onClick={() => copy("__last__", lastUrl)}
                className="rounded-md border border-hairline px-2 py-1.5 text-[12px] text-ink hover:bg-subtle"
              >
                {copiedId === "__last__" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-6 rounded-md border border-hairline bg-canvas">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">
            Pending invitations
          </h2>
          <span className="text-[12px] text-muted">
            {rows.length} {rows.length === 1 ? "invite" : "invites"}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-muted">
            No pending invitations.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="border-b border-hairline px-4 py-2 font-medium">
                    Email
                  </th>
                  <th className="border-b border-hairline px-4 py-2 font-medium">
                    Role
                  </th>
                  <th className="border-b border-hairline px-4 py-2 font-medium">
                    Expires in
                  </th>
                  <th
                    className="border-b border-hairline px-4 py-2 font-medium"
                    aria-hidden
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((inv) => (
                  <tr key={inv.id} className="hover:bg-subtle/40">
                    <td className="border-b border-hairline px-4 py-2.5 align-middle text-ink">
                      {inv.email}
                    </td>
                    <td className="border-b border-hairline px-4 py-2.5 align-middle">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                          inv.role === "admin"
                            ? "bg-accent/15 text-accent"
                            : "bg-subtle text-muted"
                        }`}
                      >
                        {inv.role}
                      </span>
                    </td>
                    <td className="border-b border-hairline px-4 py-2.5 align-middle text-muted">
                      {expiresIn(inv.expiresAt)}
                    </td>
                    <td className="border-b border-hairline px-4 py-2.5 align-middle text-right">
                      <button
                        type="button"
                        onClick={() => copy(inv.id, inv.inviteUrl)}
                        className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink hover:bg-subtle"
                      >
                        {copiedId === inv.id ? "Copied" : "Copy link"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
