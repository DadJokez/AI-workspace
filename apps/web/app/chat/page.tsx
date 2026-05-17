import { ChatClient } from "./ChatClient";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<{ threadId?: string }>;
}

export default async function ChatPage({ searchParams }: Props) {
  const params = (await searchParams) ?? {};
  return <ChatClient initialThreadId={params.threadId} />;
}
