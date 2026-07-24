"use client";

import { useState } from "react";
import type { AdminUserRow } from "@/app/api/admin/users/route";
import { EmptyState } from "@/components/EmptyState";
import { fetchJson } from "@/lib/client-api";
import { formatDate } from "@/lib/format-date";

interface Props {
  initialUsers: AdminUserRow[];
  currentUserId: string;
}

type Role = "admin" | "user";

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

export function UsersTable({ initialUsers, currentUserId }: Props) {
  const [rows, setRows] = useState(initialUsers);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [errorId, setErrorId] = useState<string | undefined>();

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
                      disabled={isBusy || isSelf}
                      onChange={(e) =>
                        changeRole(u.id, e.target.value as Role)
                      }
                      className="rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-60"
                      title={
                        isSelf ? "You can't demote yourself" : undefined
                      }
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
