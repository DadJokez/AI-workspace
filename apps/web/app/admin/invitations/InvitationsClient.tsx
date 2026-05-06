"use client";

import { useState } from "react";
import type {
  CreateInvitationResponse,
  PendingInvitationDto,
} from "@/app/api/admin/invitations/route";

type Role = "admin" | "user";

interface Props {
  initialInvitations: PendingInvitationDto[];
}

function formatExpires(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (ms >= day) {
    const d = Math.round(ms / day);
    return `in ${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.max(1, Math.round(ms / hour));
  return `in ${h} hour${h === 1 ? "" : "s"}`;
}

export function InvitationsClient({ initialInvitations }: Props) {
  const [rows, setRows] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as CreateInvitationResponse;
      setRows((rs) => [json.invitation, ...rs]);
      setEmail("");
      setRole("user");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink(row: PendingInvitationDto) {
    try {
      await navigator.clipboard.writeText(row.inviteUrl);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId((c) => (c === row.id ? undefined : c)), 1500);
    } catch {
      setError("Couldn't copy to clipboard — copy the link manually.");
    }
  }

  return (
    <div className="flex flex-col gap-6 px-6 py-4">
      <section>
        <div className="pb-3">
          <h2 className="text-base font-semibold text-ink">Invite a user</h2>
          <p className="mt-1 text-[12px] text-muted">
            Generates a one-time link valid for 7 days. Share it directly with
            the invitee — no email is sent.
          </p>
        </div>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 rounded-lg border border-hairline bg-canvas p-4 sm:flex-row sm:items-end"
        >
          <div className="flex-1">
            <label
              htmlFor="invite-email"
              className="block text-[11px] uppercase tracking-wider text-muted"
            >
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
            />
          </div>
          <div>
            <label
              htmlFor="invite-role"
              className="block text-[11px] uppercase tracking-wider text-muted"
            >
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="mt-1 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-ink px-4 py-1.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Generating…" : "Generate invite link"}
          </button>
        </form>
        {error ? (
          <p className="mt-2 text-[12px] text-red-400">{error}</p>
        ) : null}
      </section>

      <section>
        <div className="pb-3">
          <h2 className="text-base font-semibold text-ink">
            Pending invitations
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {rows.length === 0
              ? "No pending invitations."
              : `${rows.length} pending.`}
          </p>
        </div>

        {rows.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-hairline">
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
                    Invited by
                  </th>
                  <th className="border-b border-hairline px-4 py-2 font-medium">
                    Expires
                  </th>
                  <th
                    className="border-b border-hairline px-4 py-2 font-medium"
                    aria-hidden
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-subtle/40">
                    <td className="border-b border-hairline px-4 py-3 align-middle text-ink">
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
                      {r.invitedByName}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                      {formatExpires(r.expiresAt)}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-middle text-right">
                      <button
                        type="button"
                        onClick={() => copyLink(r)}
                        className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink hover:bg-subtle/40"
                      >
                        {copiedId === r.id ? "Copied" : "Copy link"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
