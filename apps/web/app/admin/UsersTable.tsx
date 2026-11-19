"use client";

import { useId, useState } from "react";
import type { AdminUserRow } from "@/app/api/admin/users/route";
import { DestructiveConfirmDialog } from "@/components/DestructiveConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ADMIN_REASON_MAX_CHARS } from "@/lib/admin-reason";
import { fetchJson } from "@/lib/client-api";
import { formatDate } from "@/lib/format-date";

interface Props {
  initialUsers: AdminUserRow[];
  currentUserId: string;
  /** Identity-provider group names per user id; absent for users with none. */
  groupsByUserId: Record<string, string[]>;
  /** Users whose role the identity provider sets at sign-in. */
  idpManagedRoleUserIds: string[];
}

type Role = "admin" | "user";
type Status = AdminUserRow["status"];
type StatusAction = "suspend" | "deprovision" | "reactivate";

/**
 * What each action does, as the confirmation states it. Mirrors
 * `lib/user-lifecycle.ts`; keep the two in step.
 */
const STATUS_ACTIONS: Record<
  StatusAction,
  { label: string; from: Status[]; effects: string }
> = {
  suspend: {
    label: "Suspend",
    from: ["active"],
    effects:
      "Signs them out everywhere and blocks sign-in, revokes their connected accounts, turns off their schedules and event triggers, and cancels their queued and running runs. Their threads, files and settings are kept.",
  },
  deprovision: {
    label: "Deprovision",
    from: ["active", "suspended"],
    effects:
      "For someone who has left. Signs them out everywhere and blocks sign-in, revokes their connected accounts, turns off their schedules and event triggers, and cancels their queued and running runs. Nothing is deleted.",
  },
  reactivate: {
    label: "Reactivate",
    from: ["suspended", "deprovisioned"],
    effects:
      "Lets them sign in again. Their schedules, event triggers and connected accounts stay off until they turn them back on.",
  },
};

const STATUS_BADGE: Record<Status, string> = {
  active: "bg-subtle text-muted",
  suspended: "bg-danger-bg text-danger",
  deprovisioned: "bg-subtle text-muted line-through",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return formatDate(iso);
}

function initials(name: string, email: string): string {
  const source = name.trim().length > 0 ? name : email;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function UsersTable({
  initialUsers,
  currentUserId,
  groupsByUserId,
  idpManagedRoleUserIds,
}: Props) {
  const [rows, setRows] = useState(initialUsers);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [errorId, setErrorId] = useState<string | undefined>();
  const [pendingStatus, setPendingStatus] = useState<{
    user: AdminUserRow;
    action: StatusAction;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const reasonId = useId();

  function openStatusDialog(user: AdminUserRow, action: StatusAction) {
    setPendingStatus({ user, action });
    setReason("");
    setStatusError(null);
  }

  async function confirmStatusChange() {
    if (!pendingStatus) return;
    const { user, action } = pendingStatus;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const data = await fetchJson<{
        user: Pick<
          AdminUserRow,
          "id" | "status" | "statusChangedAt" | "statusReason"
        >;
      }>(
        `/api/admin/users/${user.id}/status`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, reason }),
        },
        "Could not change this account.",
      );
      setRows((rs) =>
        rs.map((r) => (r.id === data.user.id ? { ...r, ...data.user } : r)),
      );
      setPendingStatus(null);
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : "Could not change this account.",
      );
    } finally {
      setStatusBusy(false);
    }
  }

  async function changeRole(id: string, nextRole: Role) {
    const prev = rows;
    setBusyId(id);
    setErrorId(undefined);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, role: nextRole } : r)));
    try {
      await fetchJson(
        `/api/admin/users/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: nextRole }),
        },
        "Could not update this role.",
      );
    } catch {
      setRows(prev);
      setErrorId(id);
    } finally {
      setBusyId(undefined);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No users yet"
        description="Invite someone to give them access to this Comparative workspace."
        actionLabel="Invite a user"
        actionHref="#invitations"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-left text-2xs uppercase tracking-wider text-muted">
            <th className="border-b border-hairline px-6 py-2 font-medium">
              User
            </th>
            <th className="border-b border-hairline px-4 py-2 font-medium">
              Role
            </th>
            <th className="border-b border-hairline px-4 py-2 font-medium">
              Status
            </th>
            <th className="border-b border-hairline px-4 py-2 font-medium">
              Joined
            </th>
            <th className="border-b border-hairline px-4 py-2 font-medium">
              Last active
            </th>
            <th
              className="border-b border-hairline px-6 py-2 font-medium"
              aria-hidden
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const isSelf = u.id === currentUserId;
            const isBusy = busyId === u.id;
            const hasError = errorId === u.id;
            const groups = groupsByUserId[u.id] ?? [];
            const idpManagedRole = idpManagedRoleUserIds.includes(u.id);
            return (
              <tr key={u.id} className="hover:bg-subtle/40">
                <td className="border-b border-hairline px-6 py-3 align-middle">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-subtle text-2xs font-medium text-ink">
                      {initials(u.displayName, u.email) || "?"}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-ink">
                        {u.displayName}
                        {isSelf ? (
                          <span className="ml-2 text-2xs text-muted">
                            (you)
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {u.email}
                      </div>
                      {groups.length > 0 ? (
                        <div
                          className="truncate text-2xs text-muted"
                          title={groups.join(", ")}
                        >
                          Groups: {groups.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="border-b border-hairline px-4 py-3 align-middle">
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${
                      u.role === "admin"
                        ? "bg-accent/15 text-accent"
                        : "bg-subtle text-muted"
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="border-b border-hairline px-4 py-3 align-middle">
                  <span
                    data-testid={`user-status-${u.id}`}
                    className={`inline-flex items-center rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${STATUS_BADGE[u.status]}`}
                    title={
                      u.statusReason
                        ? `${u.statusChangedAt ? `${formatDate(u.statusChangedAt)}: ` : ""}${u.statusReason}`
                        : undefined
                    }
                  >
                    {u.status}
                  </span>
                </td>
                <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                  {formatDate(u.createdAt)}
                </td>
                <td className="border-b border-hairline px-4 py-3 align-middle text-muted">
                  {relativeTime(u.lastSeenAt)}
                </td>
                <td className="border-b border-hairline px-6 py-3 align-middle text-right">
                  <div className="flex items-center justify-end gap-2">
                    {hasError ? (
                      <span className="text-2xs text-danger">
                        Update failed
                      </span>
                    ) : null}
                    <select
                      aria-label={`Role for ${u.displayName}`}
                      value={u.role}
                      disabled={isBusy || isSelf || idpManagedRole}
                      onChange={(e) =>
                        changeRole(u.id, e.target.value as Role)
                      }
                      className="rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-60"
                      title={
                        idpManagedRole
                          ? "Set by this user's identity provider group at sign-in"
                          : isSelf
                            ? "You can't demote yourself"
                            : undefined
                      }
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                    {isSelf
                      ? null
                      : (Object.keys(STATUS_ACTIONS) as StatusAction[])
                          .filter((action) =>
                            STATUS_ACTIONS[action].from.includes(u.status),
                          )
                          .map((action) => (
                            <button
                              key={action}
                              type="button"
                              onClick={() => openStatusDialog(u, action)}
                              aria-label={`${STATUS_ACTIONS[action].label} ${u.displayName}`}
                              className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-subtle"
                            >
                              {STATUS_ACTIONS[action].label}
                            </button>
                          ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <DestructiveConfirmDialog
        open={pendingStatus !== null}
        title={
          pendingStatus
            ? `${STATUS_ACTIONS[pendingStatus.action].label} ${pendingStatus.user.displayName}?`
            : ""
        }
        description={
          pendingStatus ? STATUS_ACTIONS[pendingStatus.action].effects : ""
        }
        actionLabel={
          pendingStatus ? STATUS_ACTIONS[pendingStatus.action].label : ""
        }
        errorMessage={statusError}
        busy={statusBusy}
        confirmDisabled={reason.trim().length === 0}
        onCancel={() => setPendingStatus(null)}
        onConfirm={confirmStatusChange}
      >
        <label
          htmlFor={reasonId}
          className="mt-3 block text-xs font-medium text-ink"
        >
          Reason (recorded in the audit log)
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={ADMIN_REASON_MAX_CHARS}
          rows={3}
          className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
        />
      </DestructiveConfirmDialog>
    </div>
  );
}
