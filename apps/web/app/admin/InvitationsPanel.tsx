"use client";

import { useRef, useState } from "react";
import type {
  AdminInvitationRow,
  AdminInvitationStatus,
} from "@/lib/admin-invitations";
import { EmptyState } from "@/components/EmptyState";

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
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [busy, setBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();

  function upsertRow(invitation: AdminInvitationRow) {
    setRows((rs) => [
      invitation,
      ...rs.filter((row) => row.id !== invitation.id),
    ]);
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
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
      const body = (await res.json()) as {
        invitation: AdminInvitationRow;
        warning?: string;
      };
      upsertRow(body.invitation);
      setNotice(invitationNotice(body.invitation, body.warning));
      setEmail("");
      setRole("user");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend(invitation: AdminInvitationRow) {
    setActionBusyId(invitation.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch(
        `/api/admin/invitations/${encodeURIComponent(invitation.id)}/resend`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        invitation?: AdminInvitationRow;
        warning?: string;
        error?: string;
      };
      if (!res.ok || !body.invitation) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      upsertRow(body.invitation);
      setNotice(invitationNotice(body.invitation, body.warning, true));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActionBusyId(undefined);
    }
  }

  async function revoke(invitation: AdminInvitationRow) {
    setActionBusyId(invitation.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await fetch(
        `/api/admin/invitations/${encodeURIComponent(invitation.id)}/revoke`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        invitation?: AdminInvitationRow;
        error?: string;
      };
      if (!res.ok || !body.invitation) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      upsertRow(body.invitation);
      setNotice(`Invite revoked for ${body.invitation.email}.`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActionBusyId(undefined);
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
    <section id="invitations" className="scroll-mt-4 py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Invitations</h2>
        <p className="mt-1 text-xs text-muted">
          Send a one-time invite to onboard a new user. Links expire after 7
          days and can be resent or revoked.
        </p>
      </div>

      <form
        onSubmit={sendInvite}
        className="flex flex-wrap items-end gap-3 px-6 pb-4"
      >
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wider text-muted">
            Email
          </span>
          <input
            ref={emailInputRef}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            className="w-72 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-muted"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wider text-muted">
            Invite role
          </span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || email.length === 0}
          className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Sending..." : "Send invite"}
        </button>
        {error ? (
          <span className="text-xs text-danger">{error}</span>
        ) : null}
      </form>

      {notice ? (
        <div className="mx-6 mb-4 rounded-md border border-hairline bg-subtle/40 px-3 py-2 text-xs text-muted">
          {notice}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-muted">
              <th className="border-b border-hairline px-6 py-2 font-medium">
                Email
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Role
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Status
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
                  colSpan={5}
                  className="border-b border-hairline"
                >
                  <EmptyState
                    title="No invitations yet"
                    description="Send an invitation when you're ready to bring someone into this workspace."
                    actionLabel="Invite someone"
                    onAction={() => emailInputRef.current?.focus()}
                    className="min-h-40"
                  />
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
                      className={`inline-flex items-center rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${
                        inv.role === "admin"
                          ? "bg-accent/15 text-accent"
                          : "bg-subtle text-muted"
                      }`}
                    >
                      {inv.role}
                    </span>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle">
                    <div className="flex flex-col gap-1">
                      <span
                        className={`inline-flex w-fit items-center rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${statusClass(
                          inv.status,
                        )}`}
                      >
                        {statusLabel(inv.status)}
                      </span>
                      <span className="text-2xs text-muted">
                        {statusDetail(inv)}
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                    {relativeFuture(inv.expiresAt)}
                  </td>
                  <td className="border-b border-hairline px-6 py-3 align-middle text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => resend(inv)}
                        disabled={!inv.canResend || actionBusyId === inv.id}
                        className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {actionBusyId === inv.id ? "Working..." : "Resend"}
                      </button>
                      <button
                        type="button"
                        onClick={() => revoke(inv)}
                        disabled={!inv.canRevoke || actionBusyId === inv.id}
                        className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Revoke
                      </button>
                      <button
                        type="button"
                        onClick={() => copy(inv.id, inv.inviteUrl)}
                        className="rounded-md border border-hairline px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-ink"
                      >
                        {copiedId === inv.id ? "Copied" : "Copy link"}
                      </button>
                    </div>
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

function statusLabel(status: AdminInvitationStatus) {
  return status.replace(/_/g, " ");
}

function statusClass(status: AdminInvitationStatus) {
  switch (status) {
    case "sent":
    case "accepted":
      return "bg-success-bg text-success";
    case "failed":
      return "bg-danger-bg text-danger";
    case "revoked":
    case "expired":
      return "bg-subtle text-muted";
    case "pending":
    default:
      return "bg-accent/15 text-accent";
  }
}

function statusDetail(invitation: AdminInvitationRow) {
  if (invitation.status === "accepted") {
    return invitation.acceptedAt
      ? `Accepted ${shortDate(invitation.acceptedAt)}`
      : "Accepted";
  }
  if (invitation.status === "revoked") {
    return invitation.revokedAt
      ? `Revoked ${shortDate(invitation.revokedAt)}`
      : "Revoked";
  }
  if (invitation.status === "expired") return "No longer usable";
  if (invitation.status === "failed") {
    return `Email failed: ${friendlyEmailCode(invitation.lastEmailError)}`;
  }
  if (invitation.lastEmailSentAt) {
    return `Sent ${shortDate(invitation.lastEmailSentAt)}`;
  }
  return "Email not sent yet";
}

function invitationNotice(
  invitation: AdminInvitationRow,
  warning?: string,
  resent = false,
) {
  if (warning || invitation.status === "failed") {
    return `Invite ${resent ? "resend" : "created"}, but email failed for ${
      invitation.email
    }: ${friendlyEmailCode(warning ?? invitation.lastEmailError)}. You can retry from the row below.`;
  }
  return `Invite ${resent ? "resent" : "sent"} to ${invitation.email}.`;
}

function friendlyError(err: unknown) {
  if (!(err instanceof Error)) return "Request failed.";
  return friendlyEmailCode(err.message);
}

function friendlyEmailCode(code: string | null | undefined) {
  switch (code) {
    case "email_provider_disabled":
      return "email is not configured";
    case "email_sender_missing":
      return "sender is missing";
    case "email_region_missing":
      return "AWS region is missing";
    case "aws_credentials_missing":
    case "aws_credentials_unavailable":
    case "aws_credentials_invalid":
      return "AWS credentials are unavailable";
    case "email_send_failed":
      return "provider rejected the email";
    case "rate_limited":
      return "too many invite sends";
    case "invitation_not_resendable":
      return "this invite can no longer be resent";
    case "invitation_already_accepted":
      return "this invite was already accepted";
    default:
      return code ?? "unknown error";
  }
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
