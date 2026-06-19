"use client";

import { useEffect, useState } from "react";

interface Props {
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

const INTEGRATIONS: Integration[] = [
  {
    id: "github",
    name: "GitHub",
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
    name: "Salesforce",
    description: "Accounts, opportunities, contacts, and pipeline notes",
    initial: "S",
    bg: "#00A1E0",
    fg: "#001E36",
    real: false,
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
    name: "Notion",
    description: "Pages, databases, and team docs",
    initial: "N",
    bg: "#000000",
    fg: "#ffffff",
    real: true,
    authHint: "Notion OAuth",
  },
  {
    id: "google",
    name: "Google Calendar",
    description: "Events, meetings, and availability",
    initial: "G",
    bg: "#34A853",
    fg: "#ffffff",
    real: false,
    authHint: "Google OAuth",
  },
];

export function ToolsPanel({ onClose, onOpenSidebar }: Props) {
  const [oauthStatus, setOauthStatus] = useState<OAuthStatusPayload>({});
  const [oauthNotice, setOauthNotice] = useState<OAuthNotice | undefined>();
  const [activeIntegration, setActiveIntegration] = useState<
    Integration | undefined
  >();

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
          Tools
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tools"
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
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-10">
          <div className="flex flex-col gap-1">
            <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted">
              Integrations
            </h2>
            <p className="text-[12px] text-muted">
              Connect a service to give chat access to your data there.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {INTEGRATIONS.map((it) => {
              const detail = oauthStatus.providerDetails?.[it.id];
              const connected =
                detail?.connected === true || oauthStatus[it.id] === true;
              const toolAvailable =
                detail?.toolAvailable ?? (it.id === "notion" ? false : connected);
              const executionPending = connected && it.id === "notion" && !toolAvailable;
              const failed =
                oauthNotice?.provider === it.id && Boolean(oauthNotice.error);
              return (
                <div
                  key={it.id}
                  data-testid={`tool-card-${it.id}`}
                  className="flex flex-col gap-3 rounded-lg border border-hairline p-4 transition-colors hover:bg-subtle"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-base font-semibold"
                      style={{ backgroundColor: it.bg, color: it.fg }}
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
                    {failed ? (
                      <span className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                        Auth failed
                      </span>
                    ) : executionPending ? (
                      <span className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                        Linked
                      </span>
                    ) : connected ? (
                      <span className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink">
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
                      <span className="rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                        {it.real ? "Not connected" : "Coming soon"}
                      </span>
                    )}
                    {it.real ? (
                      connected ? (
                        <div className="flex flex-col items-end gap-1 text-right">
                          <span className="text-[11px] text-muted">
                            {executionPending
                              ? "Setup needed for chat"
                              : "Ready in chat"}
                          </span>
                          <a
                            href={`/api/oauth/${it.id}/start`}
                            className="text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
                          >
                            Reconnect
                          </a>
                        </div>
                      ) : (
                        <a
                          href={`/api/oauth/${it.id}/start`}
                          className="rounded-md border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink hover:bg-subtle"
                        >
                          {failed ? "Reconnect" : "Connect"}
                        </a>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => setActiveIntegration(it)}
                        className="rounded-md border border-hairline bg-canvas px-3 py-1 text-xs font-medium text-ink hover:bg-subtle"
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
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
          Connection coming soon. {integration.name} integration is on our
          roadmap
          {integration.authHint ? ` using ${integration.authHint}.` : "."}
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
