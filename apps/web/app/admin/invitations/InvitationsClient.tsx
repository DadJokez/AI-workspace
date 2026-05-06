"use client";

import { useState } from "react";
import type { AdminInvitationRow } from "@/app/api/admin/invitations/route";

interface Props {
  initialInvitations: AdminInvitationRow[];
}

type Role = "admin" | "user";

function relativeExpiry(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (ms < hour) return "<1h";
  if (ms < day) return `${Math.floor(ms / hour)}h`;
  return `${Math.floor(ms / day)}d`;
}

export function InvitationsClient({ initialInvitations }: Props) {
  const [rows, setRows] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [generatedUrl, setGeneratedUrl] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setGeneratedUrl(undefined);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = (await res.json()) as
        | {
            invitation: Omit<AdminInvitationRow, "invitedByEmail">;
            inviteUrl: string;
          }
        | { error: string };
      if (!res.ok || "error" in body) {
        setError("error" in body ? body.error : `HTTP ${res.status}`);
        return;
      }
      setGeneratedUrl(body.inviteUrl);
      setRows((rs) => [
        {
          ...body.invitation,
          invitedByEmail: null,
        },
        ...rs,
      ]);
      setEmail("");
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Invitations</h2>
        <p className="mt-1 text-[12px] text-muted">
          Generate an invite link, send it to the recipient. Links expire 7 days
          after creation and can be used once.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="mx-6 mb-6 mt-2 rounded-lg border border-hairline bg-surface px-4 py-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label
              htmlFor="invite-email"
              className="mb-1 block text-[11px] uppercase tracking-wider text-muted"
            >
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="invite-role"
              className="mb-1 block text-[11px] uppercase tracking-wider text-muted"
            >
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-md border border-hairline bg-canvas px-2 py-2 text-[13px] text-ink"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={busy || email.trim().length === 0}
            className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Generating…" : "Generate invite"}
          </button>
        </div>

        {error ? (
          <p className="mt-3 text-[12px] text-red-400">
            Couldn&apos;t create invitation: {error}
          </p>
        ) : null}

        {generatedUrl ? (
          <div className="mt-4 rounded-md border border-hairline bg-canvas p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted">
              Invite link
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={generatedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded border border-hairline bg-surface px-2 py-1.5 font-mono text-[12px] text-ink"
              />
              <button
                type="button"
                onClick={copyUrl}
                className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-ink hover:bg-subtle"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Send this link to the recipient. It&apos;s only shown here once.
            </p>
          </div>
        ) : null}
      </form>

      <div className="px-6 pb-2 text-[11px] uppercase tracking-wider text-muted">
        Pending ({rows.length})
      </div>
      {rows.length === 0 ? (
        <div className="px-6 py-6 text-sm text-muted">
          No pending invitations.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="border-b border-hairline px-6 py-2 font-medium">
                  Email
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Role
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Invited by
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Expires in
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-subtle/40">
                  <td className="border-b border-hairline px-6 py-3 align-middle text-ink">
                    {r.email}
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                        r.role === "admin"
                          ? "bg-accent/15 text-accent"
                          : "bg-subtle text-muted"
                      }`}
                    >
                      {r.role}
                    </span>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                    {r.invitedByEmail ?? "—"}
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                    {relativeExpiry(r.expiresAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
