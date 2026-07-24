import { handleConversationResourceMcpRequest } from "@/lib/conversation-resource-mcp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleConversationResourceMcpRequest(req);
}

export async function GET(req: Request) {
  return handleConversationResourceMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleConversationResourceMcpRequest(req);
}
