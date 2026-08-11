import { ChatClient } from "./ChatClient";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<{
    threadId?: string;
    open?: string;
    section?: string;
    focus?: string;
    artifactId?: string;
    reviewComment?: string;
  }>;
}

export default async function ChatPage({ searchParams }: Props) {
  const params = (await searchParams) ?? {};
  const initialOpen =
    params.open === "settings" ||
    params.open === "artifacts" ||
    params.open === "studio" ||
    params.open === "upload"
      ? params.open
      : undefined;
  const initialSettingsSection =
    params.section === "memory" || params.section === "integrations"
      ? params.section
      : undefined;
  return (
    <ChatClient
      initialThreadId={params.threadId}
      initialOpen={initialOpen}
      initialSettingsSection={initialSettingsSection}
      initialMemoryId={params.focus}
      initialArtifactId={params.artifactId}
      initialReviewCommentId={params.reviewComment}
    />
  );
}
