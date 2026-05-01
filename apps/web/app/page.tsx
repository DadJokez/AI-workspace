export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">AI Hub</h1>
      <p className="text-lg text-zinc-600 dark:text-zinc-400">
        Internal AI front door. Week 1 skeleton — chat ships next.
      </p>
      <p className="text-sm text-zinc-500">
        Health endpoint:{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
