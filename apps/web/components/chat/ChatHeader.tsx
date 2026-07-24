import { AlphaBadge } from "@/components/AlphaBadge";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  compactModelName,
  runtimeLaneLabel,
  type ChatTab,
} from "@/app/chat/chat-client-state";

interface ChatHeaderProps {
  activeTab: ChatTab;
  models: ModelOption[];
  runtimeV2Enabled: boolean;
  activeHasPendingRun: boolean;
  unreadNotifications: number;
  onOpenMenu: () => void;
  onModelChange: (modelId: string) => void;
  onToggleNotifications: () => void;
  downloadHref?: string;
  onDownload: () => void;
  onStop: () => void;
}

export function ChatHeader({
  activeTab,
  models,
  runtimeV2Enabled,
  activeHasPendingRun,
  unreadNotifications,
  onOpenMenu,
  onModelChange,
  onToggleNotifications,
  downloadHref,
  onDownload,
  onStop,
}: ChatHeaderProps) {
  const lastAssistantMessage = [...activeTab.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const resolvedModel = lastAssistantMessage?.modelId
    ? models.find((model) => model.id === lastAssistantMessage.modelId)
    : undefined;
  const resolvedModelName =
    resolvedModel?.displayName ?? lastAssistantMessage?.modelId;
  const compactResolvedModelName = compactModelName(resolvedModelName);
  const resolvedLaneName = runtimeLaneLabel(lastAssistantMessage?.runtimeLane);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-hairline bg-canvas">
      <button
        type="button"
        onClick={onOpenMenu}
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
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <div
          data-testid="active-chat-title"
          className="min-w-0 truncate text-sm font-medium text-muted"
          title={activeTab.title}
        >
          {activeTab.threadId ? activeTab.title : "New chat"}
        </div>
        <AlphaBadge placement="inline" />
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 sm:gap-1.5 sm:px-3">
        {!runtimeV2Enabled && models.length > 0 && activeTab.modelId ? (
          <div className="hidden min-[400px]:block">
            <ModelSelector
              value={activeTab.modelId}
              onChange={onModelChange}
              options={models}
              disabled={activeTab.busy || activeHasPendingRun}
            />
          </div>
        ) : null}
        {runtimeV2Enabled ? (
          <div
            data-testid="resolved-model-chip"
            aria-label={
              resolvedModelName
                ? `Resolved model: ${resolvedModelName}${resolvedLaneName ? `, ${resolvedLaneName} lane` : ""}`
                : "Model selected automatically when the assistant responds"
            }
            title={
              resolvedModelName
                ? `Resolved model: ${resolvedModelName}${resolvedLaneName ? ` · ${resolvedLaneName} lane` : ""}`
                : "Comparative selects the model automatically for each turn"
            }
            className="hidden h-7 min-w-0 max-w-20 shrink items-center gap-1.5 rounded-full border border-hairline bg-subtle px-2 text-2xs text-muted min-[400px]:flex sm:max-w-56"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
            <span className="min-w-0 truncate sm:hidden">
              {compactResolvedModelName ?? "Auto"}
            </span>
            <span className="hidden min-w-0 truncate sm:inline">
              {resolvedModelName ?? "Auto model"}
            </span>
            {resolvedLaneName ? (
              <span className="hidden shrink-0 border-l border-hairline pl-1.5 sm:inline">
                {resolvedLaneName}
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          aria-label={
            unreadNotifications > 0
              ? `Notifications (${unreadNotifications} unread)`
              : "Notifications"
          }
          title="Notifications"
          data-testid="notification-bell"
          onClick={onToggleNotifications}
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:bg-subtle hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4.5-1.5 4.5h10s-1.5-1.5-1.5-4.5A3.5 3.5 0 0 0 8 2Z" />
            <path d="M6.8 12.5a1.3 1.3 0 0 0 2.4 0" />
          </svg>
          {unreadNotifications > 0 ? (
            <span
              data-testid="notification-badge"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-on-accent"
            >
              {unreadNotifications > 9 ? "9+" : unreadNotifications}
            </span>
          ) : null}
        </button>
        {downloadHref && activeTab.messages.length > 0 ? (
          <a
            role="button"
            aria-label="Download chat transcript"
            title="Download chat transcript"
            href={downloadHref}
            onClick={onDownload}
            onKeyDown={(event) => {
              if (event.key !== " ") return;
              event.preventDefault();
              event.currentTarget.click();
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:bg-subtle hover:text-ink"
          >
            <DownloadIcon />
          </a>
        ) : (
          <button
            type="button"
            aria-label="Download chat transcript"
            title="Download chat transcript"
            disabled={activeTab.messages.length === 0}
            onClick={onDownload}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:bg-subtle hover:text-ink disabled:opacity-40"
          >
            <DownloadIcon />
          </button>
        )}
        {activeTab.busy ? (
          <button
            type="button"
            aria-label="Stop generating"
            title="Stop generating"
            onClick={onStop}
            className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-hairline bg-canvas px-2 text-xs font-medium text-muted hover:bg-subtle hover:text-ink"
          >
            <span className="block h-2.5 w-2.5 rounded-xs bg-current" />
            Stop
          </button>
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 2.5v6.8" />
      <path d="m5.2 6.8 2.8 2.8 2.8-2.8" />
      <path d="M3 12.5h10" />
    </svg>
  );
}
