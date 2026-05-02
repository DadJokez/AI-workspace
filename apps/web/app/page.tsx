import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">AI Hub</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          One front door for every AI tool you have access to. Chat, run
          recipes, share workflows.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/chat"
          className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Open chat →
        </Link>
        <a
          href="/api/health"
          className="rounded-xl border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Health
        </a>
        <a
          href="/api/models"
          className="rounded-xl border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Models
        </a>
      </div>

      <p className="text-xs text-zinc-500">
        Week 1 build. Auth is hardcoded; LLM is fake. PingOne, real Bedrock,
        and Microsoft Graph land in the next PRs.
      </p>
    </main>
  );
}
