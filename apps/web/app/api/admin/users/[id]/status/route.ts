import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  deprovisionUser,
  LIFECYCLE_ERROR_MESSAGES,
  reactivateUser,
  suspendUser,
  type LifecycleAction,
} from "@/lib/user-lifecycle";

export const dynamic = "force-dynamic";

const ACTIONS = {
  suspend: suspendUser,
  deprovision: deprovisionUser,
  reactivate: reactivateUser,
} satisfies Record<LifecycleAction, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/users/[id]/status — `{ action, reason }` where action is
 * `suspend`, `deprovision` or `reactivate` and reason is 1-500 characters.
 * Admin only. The effects are listed in `lib/user-lifecycle.ts`; the response
 * carries the new status and what was withdrawn.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    reason?: unknown;
  } | null;
  const action = body?.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const result = await ACTIONS[action as LifecycleAction](
    id,
    auth.user,
    body?.reason,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: LIFECYCLE_ERROR_MESSAGES[result.error] },
      { status: result.status },
    );
  }
  return NextResponse.json({
    user: {
      id: result.user.id,
      status: result.user.status,
      statusChangedAt: result.user.statusChangedAt.toISOString(),
      statusReason: result.user.statusReason,
    },
    effects: result.effects,
  });
}
