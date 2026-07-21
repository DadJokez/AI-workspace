import { ArtifactPreviewPane } from "@/components/ArtifactPreviewPane";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { RunInspectorPane } from "@/components/RunInspectorPane";
import { SlideOverPane } from "@/components/SlideOverPane";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import type {
  RightPane,
  UiMessage,
} from "@/app/chat/chat-client-state";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

interface ChatPaneHostProps {
  rightPane: RightPane | null;
  isAdmin: boolean;
  inspectedMessage?: UiMessage;
  onClose: () => void;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
  onOpenThread: (threadId: string, title: string) => void;
  onUnreadChange: (count: number) => void;
}

export function ChatPaneHost({
  rightPane,
  isAdmin,
  inspectedMessage,
  onClose,
  onOpenArtifact,
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
  if (rightPane?.kind === "artifact") {
    return (
      <ArtifactPreviewPane artifact={rightPane.artifact} onClose={onClose} />
    );
  }
  if (rightPane?.kind === "workspace") {
    return (
      <SlideOverPane
        ariaLabel="Artifacts"
        defaultWidth={520}
        minWidth={360}
        maxWidth={800}
        onClose={onClose}
        paneTestId="artifacts-pane"
        resizerLabel="Resize artifacts"
        resizerTestId="artifacts-pane-resizer"
        storageKey="comparative.slide-over.artifacts.width"
      >
        <WorkspacePanel
          onClose={onClose}
          onOpenArtifact={onOpenArtifact}
        />
      </SlideOverPane>
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
