import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-medium tracking-tight text-ink">
          AI Hub
        </h1>
        <p className="text-base text-muted">
          One front door for every AI tool you have access to. Chat, run
          recipes, share workflows.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/chat"
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-canvas hover:opacity-90"
        >
          Open chat →
        </Link>
        <a
          href="/api/health"
          className="rounded-md border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink hover:bg-subtle"
        >
          Health
        </a>
        <a
          href="/api/models"
          className="rounded-md border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink hover:bg-subtle"
        >
          Models
        </a>
      </div>

      <p className="text-xs text-muted">
        Week 1 build. Auth is hardcoded; LLM is fake. PingOne, real Bedrock,
        and Microsoft Graph land in the next PRs.
      </p>
    </main>
  );
}
