import { ChatClient } from "./ChatClient";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<{ threadId?: string; open?: string }>;
}

export default async function ChatPage({ searchParams }: Props) {
  const params = (await searchParams) ?? {};
  const initialOpen =
    params.open === "settings" || params.open === "artifacts"
      ? params.open
      : undefined;
  return (
    <ChatClient initialThreadId={params.threadId} initialOpen={initialOpen} />
  );
}
