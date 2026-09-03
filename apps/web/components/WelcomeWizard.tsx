"use client";

import { useEffect, useRef, useState } from "react";
import { WelcomeTour } from "@/components/WelcomeTour";
import {
  migrateLegacyLocalStorage,
  WIZARD_NAME_STORAGE_KEY,
  WIZARD_STEP_STORAGE_KEY,
} from "@/lib/local-storage-migrations";
import { resolveWelcomeStep, type WelcomeStep } from "@/lib/tour";
import { useDialogFocusTrap } from "@/lib/use-dialog-focus-trap";

/**
 * First-login setup (specs/005): name the assistant, then show the factual
 * capability tour. Tool connections and profile intake stay out of the first
 * session; users can reach them later without blocking their first chat.
 */
const SUGGESTED_NAMES = ["Atlas", "Sage", "Scout", "Nova", "Pax"];

interface WelcomeWizardProps {
  open: boolean;
  initialAssistantName: string | null;
  /** Settings replays the capability tour without repeating first-run setup. */
  startAtTour?: boolean;
  /** Persist the assistant name before continuing. */
  onSave: (patch: { assistantName: string }) => Promise<void>;
  /** Called when the flow completes or is skipped. */
  onComplete: () => void;
}

export function WelcomeWizard({
  open,
  initialAssistantName,
  startAtTour = false,
  onSave,
  onComplete,
}: WelcomeWizardProps) {
  const [step, setStep] = useState<WelcomeStep>("name");
  const [name, setName] = useState(initialAssistantName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useDialogFocusTrap({
    active: open && step === "name",
    dialogRef,
    initialFocusRef: nameInputRef,
    onEscape: () => {
      clearWizardState();
      onComplete();
    },
  });

  // Restore a drafted name and carry users stranded on a retired setup step
  // directly into the tour. Only initialize once per open/close cycle so the
  // profile response from saving a name cannot reset the active step.
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;

    migrateLegacyLocalStorage(window.localStorage);
    const savedStep = window.localStorage.getItem(WIZARD_STEP_STORAGE_KEY);
    const savedName = window.localStorage.getItem(WIZARD_NAME_STORAGE_KEY);
    if (savedName && !initialAssistantName) setName(savedName);
    setStep(
      resolveWelcomeStep({
        startAtTour,
        savedStep,
        hasAssistantName: Boolean(initialAssistantName),
      }),
    );
    setError(null);
  }, [open, initialAssistantName, startAtTour]);

  useEffect(() => {
    if (open) window.localStorage.setItem(WIZARD_STEP_STORAGE_KEY, step);
  }, [open, step]);

  if (!open) return null;

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

  async function continueToTour() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ assistantName: trimmed });
      setStep("tour");
    } catch {
      setError("We couldn't save that name. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome setup"
      tabIndex={-1}
    >
      <div className="w-[min(94vw,460px)] rounded-md border border-hairline bg-canvas p-5 text-ink shadow-lg">
        <p className="text-xs font-medium text-muted">
          First-run setup
        </p>
        <h2 className="mt-1.5 text-md font-semibold">Name your assistant</h2>
        <p className="mt-1.5 text-sm text-muted">
          Choose the name you want to see in chat. You can change it later in
          Settings.
        </p>
        <input
          ref={nameInputRef}
          aria-label="Assistant name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            window.localStorage.setItem(
              WIZARD_NAME_STORAGE_KEY,
              e.target.value,
            );
          }}
          maxLength={40}
          placeholder="Atlas"
          className="mt-3 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink focus-visible:border-ink/40"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTED_NAMES.map((suggestedName) => (
            <button
              key={suggestedName}
              type="button"
              onClick={() => {
                setName(suggestedName);
                window.localStorage.setItem(
                  WIZARD_NAME_STORAGE_KEY,
                  suggestedName,
                );
              }}
              className="rounded-full border border-hairline px-2.5 py-1 text-xs text-muted hover:bg-subtle hover:text-ink"
            >
              {suggestedName}
            </button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

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
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={continueToTour}
            className="rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function clearWizardState() {
  window.localStorage.removeItem(WIZARD_STEP_STORAGE_KEY);
  window.localStorage.removeItem(WIZARD_NAME_STORAGE_KEY);
}
