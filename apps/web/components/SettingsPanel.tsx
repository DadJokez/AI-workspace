"use client";

import type { ModelOption } from "@/components/ModelSelector";
import { useDensity, type Density } from "@/lib/density";
import { useTheme, type Theme } from "@/lib/theme";
import { useEffect, useMemo, useState } from "react";

interface Props {
  userEmail?: string;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  models: readonly ModelOption[];
  defaultModelId: string;
  userDefaultModelId?: string;
  onUserDefaultModelChange: (id: string) => void;
  onClose: () => void;
  onOpenSidebar: () => void;
}

function deriveInitials(name: string, fallback: string): string {
  const source = name.trim() || fallback;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function SettingsPanel({
  userEmail,
  displayName,
  onDisplayNameChange,
  models,
  defaultModelId,
  userDefaultModelId,
  onUserDefaultModelChange,
  onClose,
  onOpenSidebar,
}: Props) {
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const [nameDraft, setNameDraft] = useState(displayName);
  const [savedFlash, setSavedFlash] = useState(false);

  // Keep input in sync if displayName changes upstream
  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

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

  function handleNameSave() {
    const trimmed = nameDraft.trim();
    if (trimmed === displayName) return;
    onDisplayNameChange(trimmed);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

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
                          handleNameSave();
                        }
                      }}
                      className="flex-1 rounded-md border border-hairline bg-canvas px-3 py-2 text-base text-ink outline-none placeholder:text-muted focus:border-ink/40"
                      placeholder="Your name"
                    />
                    {savedFlash ? (
                      <span className="text-[11px] text-muted">Saved</span>
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
            <Field label="Density">
              <SegmentedControl<Density>
                value={density}
                onChange={setDensity}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
              />
              <p className="text-[11px] text-muted">
                Compact reduces vertical spacing in the sidebar and message
                list.
              </p>
            </Field>
          </Section>

          <Divider />

          <Section title="Default model">
            <Field label="Model for new chats">
              <select
                value={currentDefault}
                onChange={(e) =>
                  onUserDefaultModelChange(e.target.value)
                }
                disabled={models.length === 0}
                className="rounded-md border border-hairline bg-canvas px-2 py-2 text-sm text-ink disabled:opacity-50 focus:outline-none"
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
              <p className="text-[11px] text-muted">
                New chats start with this model. You can still change the model
                per-tab using the dropdown in the top bar.
              </p>
            </Field>
          </Section>
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
      <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted">
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
    <label className="flex flex-col gap-1.5 text-[13px] text-ink">
      <span className="text-[12px] font-medium text-ink">{label}</span>
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
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-[12px] ${
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
