"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { connectErrorNotice } from "@/lib/connect-error-copy";
import {
  INTEGRATION_DISPLAY_NAMES,
  SETTINGS_INTEGRATIONS_LABEL,
} from "@/lib/settings-navigation";

interface Integration {
  id: string;
  name: string;
  description: string;
  initial: string;
  bg: string;
  fg: string;
  /** True when a real OAuth flow is wired up; false → placeholder modal. */
  real: boolean;
  authHint?: string;
}

interface OAuthNotice {
  provider: string;
  error?: string;
}

interface OAuthProviderDetail {
  connected?: boolean;
  executionConfigured?: boolean;
  toolAvailable?: boolean;
  status?: string;
  reason?: string;
}

interface OAuthStatusPayload extends Record<string, unknown> {
  providerDetails?: Record<string, OAuthProviderDetail>;
}

interface IntegrationCardState {
  integration: Integration;
  connected: boolean;
  executionPending: boolean;
  /** Connected, but the chat integration hasn't shipped yet (vs. a setup issue). */
  comingSoon: boolean;
  needsReconnect: boolean;
  temporarilyUnavailable: boolean;
  failed: boolean;
}

const INTEGRATIONS: Integration[] = [
  {
    id: "github",
    name: INTEGRATION_DISPLAY_NAMES.github,
    description: "Repositories, issues, and pull requests",
    initial: "G",
    bg: "#1F2328",
    fg: "#ffffff",
    real: true,
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    description: "Mail, calendar, files, Teams, and SharePoint",
    initial: "M",
    bg: "#2563EB",
    fg: "#ffffff",
    real: false,
    authHint: "Microsoft Graph delegated OAuth",
  },
  {
    id: "salesforce",
    name: INTEGRATION_DISPLAY_NAMES.salesforce,
    description: "Search and read accounts, opportunities, contacts, and pipeline (read-only)",
    initial: "S",
    bg: "#00A1E0",
    fg: "#001E36",
    real: true,
    authHint: "Salesforce OAuth",
  },
  {
    id: "servicenow",
    name: "ServiceNow",
    description: "Tickets, requests, incidents, and approvals",
    initial: "S",
    bg: "#81B5A1",
    fg: "#0B1F18",
    real: false,
    authHint: "Per-user OAuth plus queue service access",
  },
  {
    id: "sap",
    name: "SAP",
    description: "ERP finance, procurement, and supply-chain workflows",
    initial: "S",
    bg: "#0FAAFF",
    fg: "#001B3A",
    real: false,
    authHint: "SAP BTP or API Gateway",
  },
  {
    id: "sap-hana",
    name: "SAP HANA",
    description: "Operational data, analytics views, and budget queries",
    initial: "H",
    bg: "#F0AB00",
    fg: "#1F1600",
    real: false,
    authHint: "Service principal or governed query gateway",
  },
  {
    id: "workfront",
    name: "Workfront",
    description: "Projects, tasks, status, capacity, and approvals",
    initial: "W",
    bg: "#FA0F00",
    fg: "#ffffff",
    real: false,
    authHint: "Workfront OAuth",
  },
  {
    id: "databricks",
    name: "Databricks",
    description: "Notebooks, jobs, tables, and governed analytics",
    initial: "D",
    bg: "#FF3621",
    fg: "#ffffff",
    real: false,
    authHint: "Service principal",
  },
  {
    id: "notion",
    name: INTEGRATION_DISPLAY_NAMES.notion,
    description: "Search, summarize, query, create, and update workspace docs",
    initial: "N",
    bg: "#000000",
    fg: "#ffffff",
    real: true,
    authHint: "Notion OAuth",
  },
  {
    id: "google",
    name: INTEGRATION_DISPLAY_NAMES.google,
    description: "Read Gmail and Calendar, save drafts, and create confirmed events",
    initial: "G",
    bg: "#34A853",
    fg: "#ffffff",
    real: true,
    authHint: "Google OAuth",
  },
];

export function IntegrationsSettings() {
  const [oauthStatus, setOauthStatus] = useState<OAuthStatusPayload>({});
  const [loading, setLoading] = useState(true);
  const [oauthNotice, setOauthNotice] = useState<OAuthNotice | undefined>();
  const [activeIntegration, setActiveIntegration] = useState<
    Integration | undefined
  >();
  const closeIntegration = useCallback(
    () => setActiveIntegration(undefined),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/oauth/status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          setOauthStatus(data as OAuthStatusPayload);
        }
      })
      .catch(() => {
        /* network errors → tiles stay "not connected" */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("connected");
    if (!provider) return;
    const error = params.get("error") ?? undefined;
    setOauthNotice({ provider, error });
  }, []);

  const bounceNotice = oauthNotice?.error
    ? connectErrorNotice(oauthNotice.provider, oauthNotice.error)
    : undefined;

  const cards = INTEGRATIONS.map((integration): IntegrationCardState => {
    const detail = oauthStatus.providerDetails?.[integration.id];
    const connected =
      detail?.connected === true || oauthStatus[integration.id] === true;
    const toolAvailable = detail?.toolAvailable ?? connected;
    return {
      integration,
      connected,
      executionPending: connected && !toolAvailable,
      comingSoon:
        connected &&
        !toolAvailable &&
        detail?.reason === "integration_coming_soon",
      needsReconnect: detail?.status === "reconnect_required",
      temporarilyUnavailable: detail?.status === "temporarily_unavailable",
      failed:
        oauthNotice?.provider === integration.id && Boolean(oauthNotice.error),
    };
  });
  const connectedCards = cards.filter((card) => card.connected);
  const availableCards = cards.filter(
    (card) => !card.connected && card.integration.real,
  );
  const comingSoonCards = cards.filter(
    (card) => !card.connected && !card.integration.real,
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-md font-semibold text-ink">
          {SETTINGS_INTEGRATIONS_LABEL}
        </h2>
        <p className="mt-1 text-sm text-muted">
          Connect services to give Comparative access to your work.
        </p>
      </div>

      {bounceNotice ? (
        <div
          data-testid="oauth-bounce-notice"
          role="alert"
          className="rounded-md border border-danger/30 border-l-2 border-l-danger bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          {bounceNotice}
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        {!loading && connectedCards.length === 0 ? (
          <EmptyState
            title="Connect your first integration"
            description="Connected work tools let Comparative answer with your real projects, documents, and activity."
            actionLabel={`Connect ${INTEGRATION_DISPLAY_NAMES.github}`}
            actionHref="/api/oauth/github/start"
          />
        ) : null}
        {connectedCards.length > 0 ? (
          <ToolsSection
            title="Connected"
            testId="tools-section-connected"
            cards={connectedCards}
            onOpenComingSoon={setActiveIntegration}
          />
        ) : null}
        <ToolsSection
          title="Available"
          testId="tools-section-available"
          cards={availableCards}
          onOpenComingSoon={setActiveIntegration}
        />
        <ToolsSection
          title="Coming soon"
          testId="tools-section-coming-soon"
          cards={comingSoonCards}
          onOpenComingSoon={setActiveIntegration}
        />
      </div>

      {activeIntegration ? (
        <IntegrationModal
          integration={activeIntegration}
          onClose={closeIntegration}
        />
      ) : null}
    </div>
  );
}

function ToolsSection({
  title,
  testId,
  cards,
  onOpenComingSoon,
}: {
  title: string;
  testId: string;
  cards: IntegrationCardState[];
  onOpenComingSoon: (integration: Integration) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <h3 className="text-2xs font-medium uppercase tracking-wider text-muted">
        {title}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <IntegrationCard
            key={card.integration.id}
            card={card}
            onOpenComingSoon={onOpenComingSoon}
          />
        ))}
      </div>
    </section>
  );
}

function IntegrationCard({
  card,
  onOpenComingSoon,
}: {
  card: IntegrationCardState;
  onOpenComingSoon: (integration: Integration) => void;
}) {
  const {
    integration,
    connected,
    executionPending,
    comingSoon,
    needsReconnect,
    temporarilyUnavailable,
    failed,
  } = card;
  const cardTone = failed
    ? "border-danger/35 bg-danger-bg"
    : needsReconnect || temporarilyUnavailable || executionPending
      ? "border-warning/35 bg-warning-bg"
      : connected
        ? "border-success/35 bg-success-bg"
        : "border-hairline";
  return (
    <div
      data-testid={`tool-card-${integration.id}`}
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-subtle ${cardTone}`}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-base font-semibold"
          style={{ backgroundColor: integration.bg, color: integration.fg }}
          aria-hidden
        >
          {integration.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">
            {integration.name}
          </div>
          <div className="line-clamp-2 text-xs text-muted">
            {integration.description}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        {failed ? (
          <span className="inline-flex items-center gap-1 rounded bg-danger-bg px-2 py-0.5 text-2xs uppercase tracking-wider text-danger ring-1 ring-danger/25">
            Auth failed
          </span>
        ) : needsReconnect ? (
          <span className="inline-flex items-center gap-1 rounded bg-warning-bg px-2 py-0.5 text-2xs uppercase tracking-wider text-warning ring-1 ring-warning/25">
            Reconnect
          </span>
        ) : temporarilyUnavailable ? (
          <span className="inline-flex items-center gap-1 rounded bg-warning-bg px-2 py-0.5 text-2xs uppercase tracking-wider text-warning ring-1 ring-warning/25">
            Unavailable
          </span>
        ) : executionPending ? (
          <span className="inline-flex items-center gap-1 rounded bg-warning-bg px-2 py-0.5 text-2xs uppercase tracking-wider text-warning ring-1 ring-warning/25">
            Linked
          </span>
        ) : connected ? (
          <span className="inline-flex items-center gap-1 rounded bg-success-bg px-2 py-0.5 text-2xs uppercase tracking-wider text-success ring-1 ring-success/25">
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3 8 3.5 3.5L13 5" />
            </svg>
            Connected
          </span>
        ) : (
          <span className="rounded bg-subtle px-2 py-0.5 text-2xs uppercase tracking-wider text-muted">
            {integration.real ? "Not connected" : "Coming soon"}
          </span>
        )}
        {integration.real ? (
          connected ? (
            <div className="flex flex-col items-end gap-1 text-right">
              <span className="text-2xs text-muted">
                {comingSoon
                  ? "Chat actions coming soon"
                  : needsReconnect
                    ? `Renew ${integration.name} access`
                    : temporarilyUnavailable
                      ? "Try reconnecting"
                  : executionPending
                    ? "Setup needed for chat"
                    : "Ready in chat"}
              </span>
              <a
                href={`/api/oauth/${integration.id}/start`}
                className={`text-2xs underline-offset-2 hover:underline ${
                  needsReconnect ||
                  temporarilyUnavailable ||
                  (executionPending && !comingSoon)
                    ? "text-warning"
                    : "text-muted hover:text-ink"
                }`}
              >
                Reconnect
              </a>
            </div>
          ) : (
            <a
              href={`/api/oauth/${integration.id}/start`}
              className="rounded-md border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink hover:bg-subtle"
            >
              {failed ? "Reconnect" : "Connect"}
            </a>
          )
        ) : (
          <button
            type="button"
            onClick={() => onOpenComingSoon(integration)}
            className="rounded-md border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink hover:bg-subtle"
          >
            Learn more
          </button>
        )}
      </div>
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
      window.requestAnimationFrame(() => previouslyFocused?.focus());
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-modal-title"
      data-settings-nested-dialog="true"
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
            <p className="text-xs text-muted">{integration.description}</p>
          </div>
        </div>
        <p className="text-sm text-ink">
          Connection coming soon. {integration.name} integration is on our
          roadmap
          {integration.authHint ? ` using ${integration.authHint}.` : "."}
        </p>
        <div className="flex justify-end">
          <button
            ref={closeButtonRef}
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
