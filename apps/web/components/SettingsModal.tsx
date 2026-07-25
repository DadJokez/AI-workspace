"use client";

import type { ModelOption } from "@/components/ModelSelector";
import { IntegrationsSettings } from "@/components/ToolsPanel";
import { MemorySettings } from "@/components/VaultPanel";
import { useDensity, type Density } from "@/lib/density";
import { COMPARATIVE_VERSION_LABEL } from "@/lib/product-version";
import { SETTINGS_INTEGRATIONS_LABEL } from "@/lib/settings-navigation";
import { useTheme, type Theme } from "@/lib/theme";
import { useEffect, useMemo, useRef, useState } from "react";

export type SettingsSection =
  | "profile"
  | "instructions"
  | "appearance"
  | "model"
  | "memory"
  | "integrations";

interface Props {
  userEmail?: string;
  displayName: string;
  customInstructions: string | null;
  initialSection?: SettingsSection;
  /** Fired after a successful PATCH so the parent can refresh its profile state. */
  onProfileUpdated: (next: {
    displayName: string;
    customInstructions: string | null;
    defaultModelId?: string | null;
  }) => void;
  models: readonly ModelOption[];
  defaultModelId: string;
  userDefaultModelId?: string;
  onUserDefaultModelChange: (id: string) => void;
  runtimeV2Enabled?: boolean;
  onClose: () => void;
  /** Reopens the first-run welcome tour from the chat view. */
  onReplayTour?: () => void;
}

interface SectionOption {
  id: SettingsSection;
  label: string;
}

type PendingNavigation =
  | { kind: "close" }
  | { kind: "section"; section: SettingsSection }
  | { kind: "replay-tour" };

const SECTIONS: readonly SectionOption[] = [
  { id: "profile", label: "Profile" },
  { id: "instructions", label: "Instructions" },
  { id: "appearance", label: "Appearance" },
  { id: "model", label: "Model" },
  { id: "memory", label: "Memory" },
  { id: "integrations", label: SETTINGS_INTEGRATIONS_LABEL },
];

const CUSTOM_INSTRUCTIONS_MAX = 4000;
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function deriveInitials(name: string, fallback: string): string {
  const source = name.trim() || fallback;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

async function patchUser(patch: {
  displayName?: string;
  customInstructions?: string | null;
  defaultModelId?: string | null;
}): Promise<{
  displayName: string;
  customInstructions: string | null;
  defaultModelId: string | null;
} | null> {
  try {
    const response = await fetch("/api/user", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      user: {
        displayName: string;
        customInstructions: string | null;
        defaultModelId: string | null;
      };
    };
    return body.user;
  } catch {
    return null;
  }
}

export function SettingsModal({
  userEmail,
  displayName,
  customInstructions,
  initialSection = "profile",
  onProfileUpdated,
  models,
  defaultModelId,
  userDefaultModelId,
  onUserDefaultModelChange,
  runtimeV2Enabled = false,
  onClose,
  onReplayTour,
}: Props) {
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const visibleSections = useMemo(
    () =>
      runtimeV2Enabled
        ? SECTIONS.filter((section) => section.id !== "model")
        : SECTIONS,
    [runtimeV2Enabled],
  );
  const fallbackSection =
    runtimeV2Enabled && initialSection === "model" ? "profile" : initialSection;
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(fallbackSection);
  const [nameDraft, setNameDraft] = useState(displayName);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(
    customInstructions ?? "",
  );
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestCloseRef = useRef<() => void>(() => undefined);
  const warningFocusRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);
  useEffect(() => {
    setInstructionsDraft(customInstructions ?? "");
  }, [customInstructions]);
  useEffect(() => {
    if (runtimeV2Enabled && activeSection === "model") {
      setActiveSection("profile");
    }
  }, [activeSection, runtimeV2Enabled]);

  const nameDirty = nameDraft.trim() !== displayName.trim();
  const instructionsDirty =
    instructionsDraft.trim() !== (customInstructions ?? "").trim();
  const hasUnsavedChanges = nameDirty || instructionsDirty;
  const instructionsTooLong =
    instructionsDraft.length > CUSTOM_INSTRUCTIONS_MAX;
  const initials = useMemo(
    () => deriveInitials(nameDraft, userEmail ?? "?"),
    [nameDraft, userEmail],
  );
  const currentDefault = userDefaultModelId ?? defaultModelId;

  function requestNavigation(next: PendingNavigation) {
    if (hasUnsavedChanges) {
      setPendingNavigation(next);
      return;
    }
    completeNavigation(next);
  }

  function completeNavigation(next: PendingNavigation) {
    if (next.kind === "section") {
      setActiveSection(next.section);
      return;
    }
    onClose();
    if (next.kind === "replay-tour") onReplayTour?.();
  }

  requestCloseRef.current = () => requestNavigation({ kind: "close" });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    window.requestAnimationFrame(() => {
      dialog
        ?.querySelector<HTMLElement>("[data-settings-initial-focus]")
        ?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector('[data-settings-nested-dialog="true"]')) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        requestCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusScope =
        dialog.querySelector<HTMLElement>(
          '[data-settings-nested-dialog="true"]',
        ) ?? dialog;
      const focusable = Array.from(
        focusScope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!focusScope.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.requestAnimationFrame(() => {
        const fallback = document.querySelector<HTMLElement>(
          '[data-settings-trigger="true"]',
        );
        const target =
          previouslyFocused?.isConnected && previouslyFocused !== document.body
            ? previouslyFocused
            : fallback;
        target?.focus();
      });
    };
  }, []);

  useEffect(() => {
    if (!pendingNavigation) return;
    warningFocusRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingNavigation(undefined);
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [pendingNavigation]);

  async function handleNameSave() {
    const trimmed = nameDraft.trim();
    if (!trimmed || !nameDirty) return;
    setNameSaving(true);
    setSaveError(undefined);
    const updated = await patchUser({ displayName: trimmed });
    setNameSaving(false);
    if (!updated) {
      setSaveError("Could not save your profile. Try again.");
      return;
    }
    onProfileUpdated(updated);
    setNameSaved(true);
    window.setTimeout(() => setNameSaved(false), 1500);
  }

  async function handleInstructionsSave() {
    const trimmed = instructionsDraft.trim();
    if (!instructionsDirty || instructionsTooLong) return;
    setInstructionsSaving(true);
    setSaveError(undefined);
    const updated = await patchUser({
      customInstructions: trimmed.length > 0 ? trimmed : null,
    });
    setInstructionsSaving(false);
    if (!updated) {
      setSaveError("Could not save your instructions. Try again.");
      return;
    }
    onProfileUpdated(updated);
    setInstructionsSaved(true);
    window.setTimeout(() => setInstructionsSaved(false), 1500);
  }

  function discardAndContinue() {
    const next = pendingNavigation;
    if (!next) return;
    setNameDraft(displayName);
    setInstructionsDraft(customInstructions ?? "");
    setSaveError(undefined);
    setPendingNavigation(undefined);
    completeNavigation(next);
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-stretch justify-center md:items-center md:p-6">
      <button
        type="button"
        aria-label="Close settings"
        className="absolute inset-0 hidden cursor-default bg-black/45 md:block"
        onClick={() => requestNavigation({ kind: "close" })}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        data-testid="settings-modal"
        className="relative z-10 flex h-full w-full flex-col overflow-hidden border-hairline bg-canvas text-ink md:h-[min(760px,calc(100dvh-48px))] md:max-w-5xl md:rounded-lg md:border md:shadow-xl"
      >
        <header className="flex h-12 shrink-0 items-center border-b border-hairline px-4">
          <h1 id="settings-title" className="flex-1 text-sm font-semibold">
            Settings
          </h1>
          <button
            type="button"
            onClick={() => requestNavigation({ kind: "close" })}
            aria-label="Close settings"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-sidebar px-2 py-2 md:w-48 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-4"
          >
            {visibleSections.map((section, index) => {
              const active = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  type="button"
                  data-settings-initial-focus={index === 0 ? "true" : undefined}
                  aria-current={active ? "page" : undefined}
                  onClick={() =>
                    requestNavigation({ kind: "section", section: section.id })
                  }
                  className={`shrink-0 rounded-md px-3 py-2 text-left text-sm md:w-full ${
                    active
                      ? "bg-subtle font-medium text-ink"
                      : "text-muted hover:bg-subtle hover:text-ink"
                  }`}
                >
                  {section.label}
                </button>
              );
            })}
            <div className="mt-auto hidden border-t border-hairline px-3 pt-3 text-2xs font-medium uppercase tracking-caps text-muted/70 md:block">
              {COMPARATIVE_VERSION_LABEL}
            </div>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-7 sm:py-8">
              {activeSection === "profile" ? (
                <>
                  <SectionHeading
                    title="Profile"
                    description="Manage how you appear across Comparative."
                  />
                  <div className="flex items-start gap-4">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-subtle text-sm font-semibold"
                      aria-hidden="true"
                    >
                      {initials || "AI"}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-4">
                      <Field label="Display name" htmlFor="settings-display-name">
                        <input
                          id="settings-display-name"
                          type="text"
                          value={nameDraft}
                          onChange={(event) => setNameDraft(event.target.value)}
                          className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-base placeholder:text-muted"
                          placeholder="Your name"
                        />
                      </Field>
                      <Field label="Email" htmlFor="settings-email">
                        <div
                          id="settings-email"
                          className="rounded-md border border-hairline bg-subtle px-3 py-2 text-sm text-muted"
                        >
                          {userEmail ?? "—"}
                        </div>
                      </Field>
                      {saveError ? (
                        <p role="alert" className="text-xs text-danger">
                          {saveError}
                        </p>
                      ) : null}
                      <div className="flex items-center justify-end gap-2">
                        {nameSaved ? (
                          <span className="text-xs text-muted">Saved</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void handleNameSave()}
                          disabled={!nameDirty || !nameDraft.trim() || nameSaving}
                          className="rounded-md bg-pop px-3 py-1.5 text-xs font-medium text-on-pop hover:bg-pop/90 disabled:opacity-40"
                        >
                          {nameSaving ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                  {onReplayTour ? (
                    <section className="border-t border-hairline pt-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h2 className="text-sm font-medium">Welcome tour</h2>
                          <p className="mt-1 text-xs text-muted">
                            Replay the walkthrough of chat, Skills, Apps,
                            feedback, and permissions.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            requestNavigation({ kind: "replay-tour" })
                          }
                          className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-sm hover:bg-subtle"
                        >
                          Show tour
                        </button>
                      </div>
                    </section>
                  ) : null}
                </>
              ) : null}

              {activeSection === "instructions" ? (
                <>
                  <SectionHeading
                    title="Instructions"
                    description="Set the context Comparative should carry into each new conversation."
                  />
                  <Field
                    label="How should Comparative work with you?"
                    htmlFor="settings-instructions"
                  >
                    <textarea
                      id="settings-instructions"
                      value={instructionsDraft}
                      onChange={(event) =>
                        setInstructionsDraft(event.target.value)
                      }
                      rows={10}
                      placeholder="For example: I lead product operations. Keep responses concise and action-oriented."
                      className="w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-sm placeholder:text-muted"
                    />
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted">
                      Updates apply to new conversations.
                    </p>
                    <div className="flex items-center gap-2">
                      {instructionsTooLong ? (
                        <span className="text-xs text-danger">
                          {instructionsDraft.length} / {CUSTOM_INSTRUCTIONS_MAX}
                        </span>
                      ) : null}
                      {instructionsSaved ? (
                        <span className="text-xs text-muted">Saved</span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void handleInstructionsSave()}
                        disabled={
                          !instructionsDirty ||
                          instructionsTooLong ||
                          instructionsSaving
                        }
                        className="rounded-md bg-pop px-3 py-1.5 text-xs font-medium text-on-pop hover:bg-pop/90 disabled:opacity-40"
                      >
                        {instructionsSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {saveError ? (
                    <p role="alert" className="text-xs text-danger">
                      {saveError}
                    </p>
                  ) : null}
                </>
              ) : null}

              {activeSection === "appearance" ? (
                <>
                  <SectionHeading
                    title="Appearance"
                    description="Changes apply immediately on this device."
                  />
                  <Field label="Theme">
                    <SegmentedControl<Theme>
                      value={theme}
                      onChange={setTheme}
                      options={[
                        { value: "light", label: "Light" },
                        { value: "dark", label: "Dark" },
                        { value: "system", label: "System" },
                      ]}
                    />
                  </Field>
                  <Field label="Density">
                    <SegmentedControl<Density>
                      value={density}
                      onChange={setDensity}
                      options={[
                        { value: "comfortable", label: "Comfortable" },
                        { value: "compact", label: "Compact" },
                      ]}
                    />
                    <p className="text-xs text-muted">
                      Compact reduces vertical spacing in navigation and chat.
                    </p>
                  </Field>
                </>
              ) : null}

              {activeSection === "model" && !runtimeV2Enabled ? (
                <>
                  <SectionHeading
                    title="Model"
                    description="Choose the default model for new conversations."
                  />
                  <Field label="Default model" htmlFor="settings-default-model">
                    <select
                      id="settings-default-model"
                      value={currentDefault}
                      onChange={(event) =>
                        onUserDefaultModelChange(event.target.value)
                      }
                      disabled={models.length === 0}
                      className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {models.length === 0 ? (
                        <option value="">Loading…</option>
                      ) : (
                        models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName}
                          </option>
                        ))
                      )}
                    </select>
                    {models.find((model) => model.id === currentDefault)
                      ?.blurb ? (
                      <p className="text-sm">
                        {
                          models.find((model) => model.id === currentDefault)
                            ?.blurb
                        }
                      </p>
                    ) : null}
                    <p className="text-xs text-muted">
                      Existing conversations keep their selected model.
                    </p>
                  </Field>
                </>
              ) : null}

              {activeSection === "memory" ? (
                <MemorySettings userName={displayName} />
              ) : null}

              {activeSection === "integrations" ? (
                <IntegrationsSettings />
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-hairline px-4 py-2 text-2xs font-medium uppercase tracking-caps text-muted/70 md:hidden">
          {COMPARATIVE_VERSION_LABEL}
        </div>

        {pendingNavigation ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-title"
            aria-describedby="unsaved-description"
            data-settings-nested-dialog="true"
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
          >
            <div className="w-full max-w-sm rounded-lg border border-hairline bg-canvas p-5 shadow-xl">
              <h2 id="unsaved-title" className="text-sm font-semibold">
                Discard unsaved changes?
              </h2>
              <p id="unsaved-description" className="mt-2 text-sm text-muted">
                Your profile or instruction edits have not been saved.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  ref={warningFocusRef}
                  type="button"
                  onClick={() => setPendingNavigation(undefined)}
                  className="rounded-md border border-hairline px-3 py-1.5 text-sm hover:bg-subtle"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={discardAndContinue}
                  className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90"
                >
                  Discard changes
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 className="text-md font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{description}</p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex w-fit overflow-hidden rounded-md border border-hairline"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            onClick={() => onChange(option.value)}
            className={`px-3 py-1.5 text-xs ${
              active
                ? "bg-subtle text-ink"
                : "bg-canvas text-muted hover:bg-subtle hover:text-ink"
            } ${option.value !== options[0]!.value ? "border-l border-hairline" : ""}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function CloseIcon() {
  return (
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
  );
}
