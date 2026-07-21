"use client";

import type { ModelOption } from "@/components/ModelSelector";
import { useDensity, type Density } from "@/lib/density";
import { useTheme, type Theme } from "@/lib/theme";
import { useUiSkin, type UiSkin } from "@/lib/ui-skin";
import { useEffect, useMemo, useState } from "react";

interface Props {
  userEmail?: string;
  displayName: string;
  customInstructions: string | null;
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
  onOpenSidebar: () => void;
}

const CUSTOM_INSTRUCTIONS_MAX = 4000;

function deriveInitials(name: string, fallback: string): string {
  const source = name.trim() || fallback;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

async function patchUser(
  patch: {
    displayName?: string;
    customInstructions?: string | null;
    defaultModelId?: string | null;
  },
): Promise<{
  displayName: string;
  customInstructions: string | null;
  defaultModelId: string | null;
} | null> {
  try {
    const res = await fetch("/api/user", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
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

export function SettingsPanel({
  userEmail,
  displayName,
  customInstructions,
  onProfileUpdated,
  models,
  defaultModelId,
  userDefaultModelId,
  onUserDefaultModelChange,
  runtimeV2Enabled = false,
  onClose,
  onOpenSidebar,
  onReplayTour,
}: Props) {
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const { skin, setSkin } = useUiSkin();
  const [nameDraft, setNameDraft] = useState(displayName);
  const [savedFlash, setSavedFlash] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(
    customInstructions ?? "",
  );
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsSavedFlash, setInstructionsSavedFlash] = useState(false);

  // Keep drafts in sync if the parent profile changes upstream.
  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);
  useEffect(() => {
    setInstructionsDraft(customInstructions ?? "");
  }, [customInstructions]);

  // Escape closes the panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const initials = useMemo(
    () => deriveInitials(nameDraft, userEmail ?? "?"),
    [nameDraft, userEmail],
  );

  const currentDefault: string = userDefaultModelId ?? defaultModelId;

  async function handleNameSave() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === displayName) return;
    const updated = await patchUser({ displayName: trimmed });
    if (updated) {
      onProfileUpdated(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    }
  }

  async function handleInstructionsSave() {
    const trimmed = instructionsDraft.trim();
    const stored = customInstructions ?? "";
    if (trimmed === stored) return;
    setInstructionsSaving(true);
    const updated = await patchUser({
      customInstructions: trimmed.length > 0 ? trimmed : null,
    });
    setInstructionsSaving(false);
    if (updated) {
      onProfileUpdated(updated);
      setInstructionsSavedFlash(true);
      setTimeout(() => setInstructionsSavedFlash(false), 1500);
    }
  }

  const instructionsDirty =
    instructionsDraft.trim() !== (customInstructions ?? "");
  const instructionsTooLong =
    instructionsDraft.length > CUSTOM_INSTRUCTIONS_MAX;

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
          Settings
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
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
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
          <Section title="Profile">
            <div className="flex items-start gap-4">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-subtle text-sm font-semibold text-ink"
                aria-hidden
              >
                {initials || "AI"}
              </div>
              <div className="flex flex-1 flex-col gap-3">
                <Field label="Display name">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={handleNameSave}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="flex-1 rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:border-ink/40"
                      placeholder="Your name"
                    />
                    {savedFlash ? (
                      <span className="text-2xs text-muted">Saved</span>
                    ) : null}
                  </div>
                </Field>
                <Field label="Email">
                  <div className="rounded-md border border-hairline bg-subtle px-3 py-2 text-sm text-muted">
                    {userEmail ?? "—"}
                  </div>
                </Field>
              </div>
            </div>
          </Section>

          <Divider />

          <Section title="Custom instructions">
            <Field label="Tell the assistant about yourself or how you'd like it to respond">
              <textarea
                value={instructionsDraft}
                onChange={(e) => setInstructionsDraft(e.target.value)}
                rows={5}
                placeholder="E.g. 'I'm a sales rep. Keep responses concise and action-oriented.'"
                className="w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:border-ink/40"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-2xs text-muted">
                  Sent to the assistant on every new chat. Updates apply to
                  new conversations.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {instructionsTooLong ? (
                    <span className="text-2xs text-danger">
                      Too long ({instructionsDraft.length} /{" "}
                      {CUSTOM_INSTRUCTIONS_MAX})
                    </span>
                  ) : null}
                  {instructionsSavedFlash ? (
                    <span className="text-2xs text-muted">Saved</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleInstructionsSave}
                    disabled={
                      !instructionsDirty ||
                      instructionsTooLong ||
                      instructionsSaving
                    }
                    className="rounded-md bg-pop px-3 py-1 text-xs font-medium text-on-pop hover:bg-pop/90 disabled:opacity-40"
                  >
                    {instructionsSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </Field>
          </Section>

          <Divider />

          <Section title="Appearance">
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
            <Field label="Skin">
              <SegmentedControl<UiSkin>
                value={skin}
                onChange={setSkin}
                options={[
                  { value: "classic", label: "Classic" },
                  { value: "umber", label: "Umber" },
                ]}
              />
              <p className="text-2xs text-muted">
                Umber is the default visual identity. Classic remains available
                temporarily as an escape hatch on this device.
              </p>
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
              <p className="text-2xs text-muted">
                Compact reduces vertical spacing in the sidebar and message
                list.
              </p>
            </Field>
          </Section>

          {onReplayTour ? (
            <>
              <Divider />

              <Section title="Welcome tour">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted">
                    Replay the two-minute walkthrough of chat, Skills, Apps,
                    feedback, and permissions.
                  </p>
                  <button
                    type="button"
                    onClick={onReplayTour}
                    className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-subtle"
                  >
                    Show tour
                  </button>
                </div>
              </Section>
            </>
          ) : null}

          {!runtimeV2Enabled ? (
            <>
              <Divider />

              <Section title="Default model">
                <Field label="Model for new chats">
                  <select
                    value={currentDefault}
                    onChange={(e) => onUserDefaultModelChange(e.target.value)}
                    disabled={models.length === 0}
                    className="rounded-md border border-hairline bg-canvas px-2 py-2 text-sm text-ink disabled:opacity-50"
                  >
                    {models.length === 0 ? (
                      <option value="">Loading…</option>
                    ) : (
                      models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))
                    )}
                  </select>
                  {(() => {
                    const active = models.find((m) => m.id === currentDefault);
                    const blurb = active?.blurb?.trim();
                    if (!blurb) return null;
                    return <p className="text-xs text-ink">{blurb}</p>;
                  })()}
                  <p className="text-2xs text-muted">
                    New chats start with this model when runtime v2 is off.
                  </p>
                </Field>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xs font-medium uppercase tracking-wider text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-ink">
      <span className="text-xs font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}

function Divider() {
  return <div className="h-px w-full bg-hairline" aria-hidden />;
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
  onChange: (v: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex w-fit overflow-hidden rounded-md border border-hairline"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Explicit name: the surrounding Field renders a <label>, which
            // would otherwise donate its ENTIRE text content as the accessible
            // name of the group's first radio ("Theme Dark System" for Light).
            aria-label={o.label}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-xs ${
              active
                ? "bg-subtle text-ink"
                : "bg-canvas text-muted hover:bg-subtle hover:text-ink"
            } ${o.value !== options[0]!.value ? "border-l border-hairline" : ""}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
