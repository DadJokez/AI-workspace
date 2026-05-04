import { Workspace } from "@/components/chat/Workspace";
import { getCurrentUser } from "@ai-workspace/auth";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const hdrs = await headers();
  // Build a minimal Request stand-in for the auth shim.
  const user = await getCurrentUser(
    new Request("http://internal/", { headers: hdrs }),
  );
  if (!user) {
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-sm text-zinc-600 dark:text-zinc-400">
        Not signed in.
      </main>
    );
  }
  return <Workspace user={{ displayName: user.displayName, email: user.email }} />;
}
