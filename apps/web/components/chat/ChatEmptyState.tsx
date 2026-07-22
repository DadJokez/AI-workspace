import { ThinkingOrb } from "@/components/ThinkingOrb";
import {
  connectedProvidersSummary,
  firstNameFromDisplayName,
  greetingForHour,
} from "@/lib/empty-state";
import { COMPARATIVE_VERSION_LABEL } from "@/lib/product-version";

interface ChatEmptyStateProps {
  onPick: (suggestion: string) => void;
  onOpenIntegrations: () => void;
  displayName?: string;
  connectedProviders: string[] | null;
  suggestions: string[] | null;
}

export function ChatEmptyState({
  onPick,
  onOpenIntegrations,
  displayName,
  connectedProviders,
  suggestions,
}: ChatEmptyStateProps) {
  const firstName = firstNameFromDisplayName(displayName);
  const greeting = greetingForHour(new Date().getHours());
  const integrationAction =
    connectedProviders?.length === 0
      ? "Connect one in Integrations."
      : connectedProviders
        ? "Manage them in Integrations."
        : "Open Integrations.";

  return (
    <div
      data-testid="chat-empty-state"
      className="flex flex-col items-center gap-4 py-24 text-center"
    >
      <ThinkingOrb
        state="idle"
        size={176}
        stroke={6}
        label="Comparative"
        className="text-ink"
      />
      <div
        data-testid="empty-state-greeting"
        className="font-serif text-2xl font-normal text-ink"
      >
        {greeting}
        {firstName ? `, ${firstName}` : ""}.
      </div>
      <p className="max-w-md text-sm text-muted">
        {connectedProvidersSummary(connectedProviders)}{" "}
        <button
          type="button"
          onClick={onOpenIntegrations}
          className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
        >
          {integrationAction}
        </button>
      </p>
      <div className="text-2xs font-medium uppercase tracking-caps text-muted/60">
        {COMPARATIVE_VERSION_LABEL}
      </div>
      {suggestions ? (
        <div className="empty-state-suggestions flex flex-wrap justify-center gap-2 pt-4">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onPick(suggestion)}
              className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
