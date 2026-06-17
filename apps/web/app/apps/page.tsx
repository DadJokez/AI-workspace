import { apps, getDb, workspaceArtifacts } from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterAppForm } from "@/components/apps/RegisterAppForm";
import { isServableArtifact, listAppSharesWithRoles } from "@/lib/apps";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

/**
 * Apps home: deployed thin apps you own or that were shared with you, plus
 * the deploy entry point — pick any HTML artifact a conversation produced
 * and give it a name.
 */
export default async function AppsPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");

  const db = getDb();
  const mine = await db
    .select()
    .from(apps)
    .where(and(eq(apps.ownerUserId, sessionUser.id), isNull(apps.archivedAt)))
    .orderBy(desc(apps.updatedAt));
  const shared = (await listAppSharesWithRoles(db, sessionUser.id)).filter(
    ({ app }) => app.ownerUserId !== sessionUser.id,
  );

  const recentArtifacts = (
    await db
      .select()
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.userId, sessionUser.id))
      .orderBy(desc(workspaceArtifacts.createdAt))
      .limit(50)
  )
    .filter(isServableArtifact)
    .slice(0, 20);

  return (
    <section className="flex flex-col gap-6 px-6 py-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Your apps</h2>
        <p className="mt-1 text-[12px] text-muted">
          Small tools built in conversation, served behind workspace sign-in.
          No repos, no pipelines — describe, deploy, share.
        </p>
      </div>

      {mine.length === 0 && shared.length === 0 ? (
        <p className="rounded-md border border-hairline px-4 py-6 text-center text-[13px] text-muted">
          No apps yet. Ask the assistant to build a small HTML page in chat,
          then deploy it below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...mine.map((app) => ({ app, sharedWithMe: false, role: null })),
            ...shared.map(({ app, role }) => ({
              app,
              sharedWithMe: true,
              role,
            }))].map(({ app, sharedWithMe, role }) => (
              <li
                key={app.id}
                className="flex items-center justify-between rounded-md border border-hairline px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {app.name}
                    {sharedWithMe ? (
                      <span className="ml-2 rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        Shared {role === "editor" ? "editor" : "viewer"}
                      </span>
                    ) : null}
                    {app.status !== "deployed" ? (
                      <span className="ml-2 rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        Draft
                      </span>
                    ) : null}
                  </p>
                  {app.description ? (
                    <p className="mt-0.5 truncate text-[12px] text-muted">
                      {app.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[13px]">
                  {app.status === "deployed" && app.liveArtifactId ? (
                    <a
                      href={`/apps/${app.slug}`}
                      className="font-medium text-ink hover:underline"
                    >
                      Open
                    </a>
                  ) : null}
                  {app.ownerUserId === sessionUser.id || role === "editor" ? (
                    <Link
                      href={`/apps/manage/${app.id}`}
                      className="text-muted hover:text-ink"
                    >
                      {app.ownerUserId === sessionUser.id ? "Manage" : "Edit"}
                    </Link>
                  ) : null}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="border-t border-hairline pt-5">
        <h3 className="text-[14px] font-semibold text-ink">Deploy an app</h3>
        <p className="mt-1 text-[12px] text-muted">
          Pick an HTML artifact from your conversations. Deploying serves it at
          a workspace URL only signed-in teammates you share it with can open.
        </p>
        <div className="mt-3">
          <RegisterAppForm
            artifacts={recentArtifacts.map((artifact) => ({
              id: artifact.id,
              title: artifact.title,
              filename: artifact.filename,
              createdAt: artifact.createdAt.toISOString(),
            }))}
          />
        </div>
      </div>
    </section>
  );
}
