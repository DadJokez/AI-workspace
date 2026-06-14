import { notFound } from "next/navigation";
import { ChatClient } from "@/app/chat/ChatClient";

export const dynamic = "force-dynamic";

export default function E2EChatPage() {
  if (process.env.E2E_TEST_MODE !== "1") {
    notFound();
  }

  return <ChatClient />;
}
