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

interface Integration {
  id: string;
  name: string;
  description: string;
  initial: string;
  bg: string;
  fg: string;
}

const INTEGRATIONS: Integration[] = [
  {
    id: "ms365",
    name: "Microsoft 365",
    description: "Access emails, calendar, Teams, and SharePoint",
    initial: "M",
    bg: "#1E6FD9",
    fg: "#ffffff",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search messages, channels, and files",
    initial: "S",
    bg: "#4A154B",
    fg: "#ffffff",
  },
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Drive, Docs, and Calendar",
    initial: "G",
    bg: "#188038",
    fg: "#ffffff",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description: "CRM data, accounts, and opportunities",
    initial: "S",
    bg: "#00A1E0",
    fg: "#ffffff",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, and pull requests",
    initial: "G",
    bg: "#1F2328",
    fg: "#ffffff",
  },
  {
    id: "sap",
    name: "SAP",
    description: "ERP data and business processes",
    initial: "S",
    bg: "#0A6ED1",
    fg: "#ffffff",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Issues, sprints, and project tracking",
    initial: "J",
    bg: "#2684FF",
    fg: "#ffffff",
  },
  {
    id: "servicenow",
    name: "ServiceNow",
    description: "Tickets, incidents, and ITSM workflows",
    initial: "S",
    bg: "#00754A",
    fg: "#ffffff",
  },
];

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "⌘ K  /  Ctrl K", label: "Search" },
  { keys: "⌘ N  /  Ctrl N", label: "New chat" },
  { keys: "⌘ W  /  Ctrl W", label: "Close tab" },
  { keys: "⌘ \\  /  Ctrl \\", label: "Toggle sidebar" },
  { keys: "⌘ ,  /  Ctrl ,", label: "Open settings" },
  { keys: "↑", label: "Edit last message" },
  { keys: "Esc", label: "Cancel / close" },
];

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
  const [activeIntegration, setActiveIntegration] = useState<
    Integration | undefined
  >();

  // Keep input in sync if displayName changes upstream
  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  // Escape closes the panel (or the modal if open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (activeIntegration) {
        setActiveIntegration(undefined);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIntegration, onClose]);

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

          <Divider />

          <Section title="Integrations">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {INTEGRATIONS.map((it) => (
                <div
                  key={it.id}
                  className="flex flex-col gap-3 rounded-lg border border-hairline p-4 transition-colors hover:bg-subtle"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-base font-semibold"
                      style={{
                        backgroundColor: it.bg,
                        color: it.fg,
                      }}
                      aria-hidden
                    >
                      {it.initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">
                        {it.name}
                      </div>
                      <div className="line-clamp-2 text-[12px] text-muted">
                        {it.description}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                      Not connected
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveIntegration(it)}
                      className="rounded-md border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink hover:bg-subtle"
                    >
                      Connect
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="self-start text-[12px] text-muted hover:text-ink"
              onClick={() => {
                /* placeholder */
              }}
            >
              Browse all integrations →
            </button>
          </Section>

          <Divider />

          <Section title="Keyboard shortcuts">
            <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
              {SHORTCUTS.map((s, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="text-ink">{s.label}</span>
                  <span className="font-mono text-[12px] text-muted">
                    {s.keys}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>

      {activeIntegration ? (
        <IntegrationModal
          integration={activeIntegration}
          onClose={() => setActiveIntegration(undefined)}
        />
      ) : null}
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

function IntegrationModal({
  integration,
  onClose,
}: {
  integration: Integration;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-modal-title"
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-lg border border-hairline bg-canvas p-5 text-ink">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-base font-semibold"
            style={{
              backgroundColor: integration.bg,
              color: integration.fg,
            }}
            aria-hidden
          >
            {integration.initial}
          </div>
          <div className="min-w-0 flex-1">
            <h3
              id="integration-modal-title"
              className="text-sm font-medium text-ink"
            >
              {integration.name}
            </h3>
            <p className="text-[12px] text-muted">{integration.description}</p>
          </div>
        </div>
        <p className="text-sm text-ink">
          OAuth connection coming soon. {integration.name} integration is on
          our roadmap.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
