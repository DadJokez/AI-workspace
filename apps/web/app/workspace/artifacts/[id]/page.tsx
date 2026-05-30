import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  loadWorkspaceArtifactForUser,
  serializeWorkspaceArtifact,
} from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

export default async function WorkspaceArtifactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    if (err instanceof AuthConfigError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-canvas px-4 text-ink">
          <div className="max-w-lg rounded-lg border border-hairline px-4 py-3 text-sm">
            {err.message}
          </div>
        </main>
      );
    }
    throw err;
  }
  if (!sessionUser) redirect("/login");

  const artifact = await loadWorkspaceArtifactForUser({
    db: getDb(),
    userId: sessionUser.id,
    artifactId: id,
  });
  if (!artifact) notFound();

  const summary = serializeWorkspaceArtifact(artifact);
  const isHtml = artifact.mimeType === "text/html";
  const isMarkdown = artifact.mimeType === "text/markdown";

  return (
    <main className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-4 py-2">
        <Link
          href="/chat"
          className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-subtle hover:text-ink"
        >
          Back to chat
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{artifact.title}</h1>
          <p className="truncate text-[12px] text-muted">
            {artifact.filename} · {formatBytes(artifact.sizeBytes)}
          </p>
        </div>
        <a
          href={summary.downloadUrl}
          className="rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90"
        >
          Download
        </a>
      </header>

      <section className="min-h-0 flex-1 overflow-auto">
        {isHtml ? (
          <iframe
            title={artifact.title}
            sandbox="allow-scripts allow-forms"
            srcDoc={artifact.content}
            className="h-[calc(100vh-3.5rem)] w-full border-0 bg-white"
          />
        ) : isMarkdown ? (
          <article className="mx-auto max-w-4xl px-4 py-6 text-sm leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {artifact.content}
            </ReactMarkdown>
          </article>
        ) : (
          <pre className="m-0 min-h-full overflow-auto whitespace-pre-wrap px-4 py-4 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere]">
            {artifact.content}
          </pre>
        )}
      </section>
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
