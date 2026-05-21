"use client";

interface Props {
  onClose: () => void;
  onOpenSidebar: () => void;
}

const profile = {
  name: "Rob L.",
  title: "AI Workspace Pilot Lead",
  org: "Digital Enablement",
  location: "US Eastern time",
  status: "Seed profile",
};

const details = [
  { label: "Working style", value: "Direct, iterative, prefers visible progress" },
  { label: "Decision frame", value: "Pragmatic enterprise fit before novelty" },
  { label: "Communication", value: "Plain English first, technical depth on demand" },
  { label: "Risk focus", value: "IT readiness, governance, reliability, and scale" },
];

const responsibilities = [
  "Shape the AI Hub pilot into a credible enterprise product",
  "Translate user workflows into tool, recipe, and scheduling requirements",
  "Keep GitHub, AWS, Cursor, and documentation aligned with the roadmap",
  "Pressure-test architecture before broader internal rollout",
];

const priorities = [
  {
    title: "Long-running work",
    detail: "Background runs, resume/retry/cancel, and clear activity state",
  },
  {
    title: "Tool governance",
    detail: "Provider approvals, audit trails, redaction, and policy gates",
  },
  {
    title: "Scheduled agents",
    detail: "Recurring workflows that create durable runs and report back",
  },
  {
    title: "Artifacts",
    detail: "Generated files that users can find, open, and reuse",
  },
];

const systems = [
  "GitHub",
  "AWS App Runner",
  "ECS/Fargate target",
  "Cursor SDK",
  "Microsoft 365",
  "Salesforce",
  "ServiceNow",
  "SAP",
];

const agentContext = [
  "Assume this user is evaluating enterprise AI adoption, not just a hobby app.",
  "Explain tradeoffs concretely: what works now, what is pilot-only, what needs hardening.",
  "Prefer small, verified increments over broad speculative rebuilds.",
  "Surface product implications when infrastructure choices affect non-technical users.",
];

export function VaultPanel({ onClose, onOpenSidebar }: Props) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-canvas">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:bg-subtle hover:text-ink md:hidden"
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>
        <h1 className="flex-1 truncate px-2 text-sm font-medium text-ink">
          Vault
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close vault"
          className="mr-2 flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
            <div className="rounded-lg border border-hairline bg-canvas p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-ink text-sm font-semibold text-canvas">
                    RL
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-ink">
                        {profile.name}
                      </h2>
                      <span className="rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                        {profile.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-ink">{profile.title}</p>
                    <p className="text-[12px] text-muted">
                      {profile.org} · {profile.location}
                    </p>
                  </div>
                </div>
                <div className="text-right text-[12px] text-muted">
                  <div>Profile owner</div>
                  <div className="font-medium text-ink">{profile.name}</div>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {details.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-md border border-hairline bg-subtle/35 p-3"
                  >
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
                      {item.label}
                    </div>
                    <div className="mt-1 text-[13px] leading-relaxed text-ink">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-hairline bg-canvas p-5">
              <h2 className="text-sm font-semibold text-ink">Agent Context</h2>
              <div className="mt-3 flex flex-col gap-2">
                {agentContext.map((item) => (
                  <div key={item} className="flex gap-2 text-[13px] text-ink">
                    <span
                      className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                      aria-hidden
                    />
                    <span className="leading-relaxed">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <VaultCard title="Responsibilities">
              <ul className="flex flex-col gap-2">
                {responsibilities.map((item) => (
                  <li key={item} className="text-[13px] leading-relaxed text-ink">
                    {item}
                  </li>
                ))}
              </ul>
            </VaultCard>

            <VaultCard title="Current Priorities">
              <div className="flex flex-col gap-3">
                {priorities.map((item) => (
                  <div key={item.title}>
                    <div className="text-[13px] font-medium text-ink">
                      {item.title}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-muted">
                      {item.detail}
                    </div>
                  </div>
                ))}
              </div>
            </VaultCard>

            <VaultCard title="Systems Context">
              <div className="flex flex-wrap gap-2">
                {systems.map((system) => (
                  <span
                    key={system}
                    className="rounded-md border border-hairline bg-subtle px-2 py-1 text-[12px] text-ink"
                  >
                    {system}
                  </span>
                ))}
              </div>
            </VaultCard>
          </section>

          <section className="rounded-lg border border-hairline bg-canvas p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Vault Notes</h2>
                <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">
                  Placeholder profile data for the pilot. Later this can become
                  a governed user-memory store with approvals, provenance, and
                  per-field visibility controls.
                </p>
              </div>
              <span className="rounded bg-subtle px-2 py-1 text-[10px] uppercase tracking-wider text-muted">
                Read-only
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function VaultCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-hairline bg-canvas p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
