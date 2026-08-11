import { ContributionStudio } from "@/components/ContributionStudio";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { RunInspectorPane } from "@/components/RunInspectorPane";
import { SlideOverPane } from "@/components/SlideOverPane";
import type {
  RightPane,
  UiMessage,
} from "@/app/chat/chat-client-state";
import type { ContributionStudioScope } from "@/lib/contribution-studio";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type { ArtifactReviewSelection } from "@/lib/artifact-review-client";

interface ChatPaneHostProps {
  rightPane: RightPane | null;
  isAdmin: boolean;
  messages: readonly UiMessage[];
  inspectedMessage?: UiMessage;
  onClose: () => void;
  onOpenArtifact: (
    artifact: WorkspaceArtifactSummary,
    scope: ContributionStudioScope,
  ) => void;
  onOpenRunInspector: (runId: string) => void;
  onAddressArtifactReview: (input: {
    artifact: WorkspaceArtifactSummary;
    comments: ArtifactReviewSelection[];
  }) => Promise<boolean>;
  onOpenThread: (threadId: string, title: string) => void;
  onUnreadChange: (count: number) => void;
}

export function ChatPaneHost({
  rightPane,
  isAdmin,
  messages,
  inspectedMessage,
  onClose,
  onOpenArtifact,
  onOpenRunInspector,
  onAddressArtifactReview,
  onOpenThread,
  onUnreadChange,
}: ChatPaneHostProps) {
  if (rightPane?.kind === "inspector" && isAdmin) {
    return (
      <RunInspectorPane
        runId={rightPane.runId}
        onClose={onClose}
        liveReasoning={inspectedMessage?.providerReasoning}
      />
    );
  }
  if (rightPane?.kind === "studio") {
    return (
      <ContributionStudio
        messages={messages}
        artifact={rightPane.artifact}
        requestedTab={rightPane.tab}
        scope={rightPane.scope}
        isAdmin={isAdmin}
        onClose={onClose}
        onOpenArtifact={onOpenArtifact}
        onOpenRunInspector={onOpenRunInspector}
        focusReviewCommentId={rightPane.focusReviewCommentId}
        onAddressArtifactReview={onAddressArtifactReview}
      />
    );
  }
  if (rightPane?.kind === "notifications") {
    return (
      <SlideOverPane
        ariaLabel="Notifications"
        defaultWidth={440}
        minWidth={360}
        maxWidth={720}
        onClose={onClose}
        paneTestId="notifications-pane"
        resizerLabel="Resize notifications"
        resizerTestId="notifications-pane-resizer"
        storageKey="comparative.slide-over.notifications.width"
      >
        <NotificationsPanel
          onClose={onClose}
          onOpenThread={onOpenThread}
          onUnreadChange={onUnreadChange}
        />
      </SlideOverPane>
    );
  }
  return null;
}
