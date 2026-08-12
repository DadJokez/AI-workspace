import { notFound } from "next/navigation";
import { ChatClient } from "@/app/chat/ChatClient";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<{
    threadId?: string;
    artifactId?: string;
    reviewComment?: string;
  }>;
}

export default async function E2EChatPage({ searchParams }: Props) {
  if (process.env.E2E_TEST_MODE !== "1") {
    notFound();
  }

  const params = (await searchParams) ?? {};
  return (
    <ChatClient
      initialThreadId={params.threadId}
      initialArtifactId={params.artifactId}
      initialReviewCommentId={params.reviewComment}
    />
  );
}
