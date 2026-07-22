"use client";

import { useEffect, useState } from "react";
import { WelcomeTour } from "@/components/WelcomeTour";
import {
  migrateLegacyLocalStorage,
  WIZARD_NAME_STORAGE_KEY,
  WIZARD_STEP_STORAGE_KEY,
} from "@/lib/local-storage-migrations";

/**
 * First-login setup wizard (specs/005). Four steps: name your assistant →
 * connect tools → about your work → capability walkthrough (the shipped
 * WelcomeTour). The whole flow is gated by `tour_completed_at` (reused from
 * #136); finishing the tour persists completion.
 *
 * OAuth resume: connecting a tool round-trips through the provider and back
 * to /chat. We persist the step in localStorage so the wizard reopens at the
 * tools step with the assistant name (already saved server-side) intact.
 */
const SUGGESTED_NAMES = ["Hub", "Atlas", "Sage", "Nova", "Pax"];
const ROLE_OPTIONS = [
  "Product / Program",
  "Engineering",
  "Operations",
  "Finance",
  "Sales / Account",
  "Analyst / Data",
  "Other",
];
const TOOL_OPTIONS = [
  "GitHub",
  "Files / Docs",
  "Outlook / M365",
  "Salesforce",
  "Workfront",
  "Excel",
  "Slack / Teams",
];

interface WelcomeWizardProps {
  open: boolean;
  initialAssistantName: string | null;
  /** Provider connection status, e.g. { github: true }. */
  connected: Record<string, boolean>;
  /** Persist a partial profile update (assistant name, onboarding answers). */
  onSave: (patch: {
    assistantName?: string;
    onboarding?: { role?: string; tools?: string[]; firstTask?: string };
  }) => Promise<void>;
  /** Opens the full Integrations settings section without losing wizard progress. */
  onOpenIntegrations: () => void;
  /** Called when the whole flow (including the tour) completes or is skipped. */
  onComplete: () => void;
}

type Step = "name" | "tools" | "about" | "tour";
const ORDER: Step[] = ["name", "tools", "about", "tour"];

export function WelcomeWizard({
  open,
  initialAssistantName,
  connected,
  onSave,
  onOpenIntegrations,
  onComplete,
}: WelcomeWizardProps) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState(initialAssistantName ?? "");
  const [role, setRole] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [firstTask, setFirstTask] = useState("");
  const [busy, setBusy] = useState(false);

  // Resume after an OAuth redirect: restore the step + drafted name.
  useEffect(() => {
    if (!open) return;
    migrateLegacyLocalStorage(window.localStorage);
    const savedStep = window.localStorage.getItem(
      WIZARD_STEP_STORAGE_KEY,
    ) as Step | null;
    const savedName = window.localStorage.getItem(WIZARD_NAME_STORAGE_KEY);
    if (savedName && !initialAssistantName) setName(savedName);
    if (savedStep && ORDER.includes(savedStep)) setStep(savedStep);
  }, [open, initialAssistantName]);

  useEffect(() => {
    if (open) window.localStorage.setItem(WIZARD_STEP_STORAGE_KEY, step);
  }, [open, step]);

  if (!open) return null;

  // The capability walkthrough is the existing tour, re-titled by step 4.
  if (step === "tour") {
    return (
      <WelcomeTour
        open
        onClose={() => {
          clearWizardState();
          onComplete();
        }}
      />
    );
  }

  const stepIndex = ORDER.indexOf(step);

  async function goNext() {
    setBusy(true);
    try {
      if (step === "name") {
        const trimmed = name.trim();
        await onSave({ assistantName: trimmed || "Hub" });
        setStep("tools");
      } else if (step === "tools") {
        setStep("about");
      } else if (step === "about") {
        await onSave({
          onboarding: {
            role: role || undefined,
            tools: tools.length ? tools : undefined,
            firstTask: firstTask.trim() || undefined,
          },
        });
        setStep("tour");
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleTool(t: string) {
    setTools((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  const assistantLabel = name.trim() || "your assistant";

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome setup"
    >
      <div className="w-[min(94vw,460px)] rounded-xl border border-hairline bg-canvas p-5 text-ink shadow-2xl">
        <div className="mb-3 flex items-center gap-1.5">
          {ORDER.slice(0, 3).map((s, i) => (
            <span
              key={s}
              className={`h-1 flex-1 rounded-full ${i <= stepIndex ? "bg-ink" : "bg-hairline"}`}
            />
          ))}
        </div>

        {step === "name" ? (
          <div>
            <h2 className="text-md font-semibold">Name your assistant</h2>
            <p className="mt-1.5 text-sm text-muted">
              This is your personal AI at work. Give it a name — it&apos;ll
              show up in your chats.
            </p>
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                window.localStorage.setItem(
                  WIZARD_NAME_STORAGE_KEY,
                  e.target.value,
                );
              }}
              maxLength={40}
              placeholder="Hub"
              className="mt-3 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink focus-visible:border-ink/40"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTED_NAMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setName(n)}
                  className="rounded-full border border-hairline px-2.5 py-1 text-xs text-muted hover:bg-subtle hover:text-ink"
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ) : step === "tools" ? (
          <div>
            <h2 className="text-md font-semibold">
              Connect your tools
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              Let {assistantLabel} work with your real systems. You approve
              every connection; everything it does is audited.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <a
                href="/api/oauth/github/start"
                className={`flex items-center justify-between rounded-md border px-3 py-2.5 text-base ${
                  connected.github
                    ? "border-success/40 bg-success-bg"
                    : "border-hairline hover:bg-subtle"
                }`}
              >
                <span className="font-medium text-ink">GitHub</span>
                <span className="text-xs text-muted">
                  {connected.github ? "✓ Connected" : "Connect →"}
                </span>
              </a>
              <div className="flex items-center justify-between rounded-md border border-hairline px-3 py-2.5 text-base opacity-60">
                <span className="text-ink">
                  Microsoft 365, Salesforce, Workfront…
                </span>
                <span className="text-xs text-muted">Coming soon</span>
              </div>
              <button
                type="button"
                onClick={onOpenIntegrations}
                className="self-start text-xs font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
              >
                Manage all integrations
              </button>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-md font-semibold">About your work</h2>
            <p className="mt-1.5 text-sm text-muted">
              Three quick questions so {assistantLabel} starts out knowing a
              little about you.
            </p>
            <label className="mt-3 block text-xs text-muted">
              What&apos;s your role?
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-2 text-base text-ink"
              >
                <option value="">Choose…</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 text-xs text-muted">
              Which tools do you live in?
              <div className="mt-1 flex flex-wrap gap-1.5">
                {TOOL_OPTIONS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTool(t)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      tools.includes(t)
                        ? "border-ink bg-ink text-canvas"
                        : "border-hairline text-muted hover:bg-subtle hover:text-ink"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <label className="mt-3 block text-xs text-muted">
              One thing you&apos;d hand off first?
              <input
                value={firstTask}
                onChange={(e) => setFirstTask(e.target.value)}
                maxLength={200}
                placeholder="e.g. summarizing my weekly status"
                className="mt-1 w-full rounded-md border border-hairline bg-canvas px-2 py-2 text-base text-ink focus-visible:border-ink/40"
              />
            </label>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              clearWizardState();
              onComplete();
            }}
            className="text-xs text-muted hover:text-ink"
          >
            Skip setup
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 ? (
              <button
                type="button"
                onClick={() => setStep(ORDER[stepIndex - 1]!)}
                className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-subtle"
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || (step === "name" && !name.trim())}
              onClick={goNext}
              className="rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
            >
              {step === "tools" && !connected.github
                ? "Skip for now"
                : step === "about"
                  ? "Finish setup"
                  : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function clearWizardState() {
  window.localStorage.removeItem(WIZARD_STEP_STORAGE_KEY);
  window.localStorage.removeItem(WIZARD_NAME_STORAGE_KEY);
}
