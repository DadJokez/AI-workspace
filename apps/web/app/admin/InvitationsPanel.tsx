"use client";

import { useState } from "react";
import type { AdminInvitationRow } from "@/app/api/admin/invitations/route";

type Role = "admin" | "user";

interface Props {
  initialInvitations: AdminInvitationRow[];
}

function relativeFuture(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  if (diff <= 0) return "expired";
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < hour) return `in ${Math.floor(diff / min)}m`;
  if (diff < day) return `in ${Math.floor(diff / hour)}h`;
  return `in ${Math.floor(diff / day)}d`;
}

export function InvitationsPanel({ initialInvitations }: Props) {
  const [rows, setRows] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [latestUrl, setLatestUrl] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { invitation: AdminInvitationRow };
      setRows((rs) => [body.invitation, ...rs]);
      setLatestUrl(body.invitation.inviteUrl);
      setEmail("");
      setRole("user");
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
      setTimeout(() => setCopiedId((cur) => (cur === id ? undefined : cur)), 1500);
    } catch {
      // Ignore — clipboard API can fail in non-secure contexts; user can
      // still select the link by hand.
    }
  }

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Invitations</h2>
        <p className="mt-1 text-[12px] text-muted">
          Generate a one-time link to onboard a new user. Links expire after 7
          days.
        </p>
      </div>

      <form
        onSubmit={generate}
        className="flex flex-wrap items-end gap-3 px-6 pb-4"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">
            Email
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            className="w-72 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-[13px] text-ink placeholder:text-muted"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">
            Role
          </span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || email.length === 0}
          className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Generating…" : "Generate Link"}
        </button>
        {error ? (
          <span className="text-[12px] text-red-400">{error}</span>
        ) : null}
      </form>

      {latestUrl ? (
        <div className="mx-6 mb-4 rounded-md border border-hairline bg-subtle/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted">
            New invite link
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              readOnly
              value={latestUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded border border-hairline bg-canvas px-2 py-1 text-[12px] text-ink"
            />
            <button
              type="button"
              onClick={() => copy("__latest", latestUrl)}
              className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink hover:bg-subtle"
            >
              {copiedId === "__latest" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}

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
                Expires
              </th>
              <th
                className="border-b border-hairline px-6 py-2 font-medium"
                aria-hidden
              />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="border-b border-hairline px-6 py-8 text-center text-[12px] text-muted"
                >
                  No pending invitations.
                </td>
              </tr>
            ) : (
              rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-subtle/40">
                  <td className="border-b border-hairline px-6 py-3 align-middle text-ink">
                    {inv.email}
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle">
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
                  <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                    {relativeFuture(inv.expiresAt)}
                  </td>
                  <td className="border-b border-hairline px-6 py-3 align-middle text-right">
                    <button
                      type="button"
                      onClick={() => copy(inv.id, inv.inviteUrl)}
                      className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink hover:bg-subtle"
                    >
                      {copiedId === inv.id ? "Copied" : "Copy link"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
