import { disabledConnectorResponse } from "@/lib/deployment-config";
import { handleNotionMcpRequest } from "@/lib/notion/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const disabled = disabledConnectorResponse("notion");
  if (disabled) return disabled;
  return handleNotionMcpRequest(req);
}

export async function GET() {
  const disabled = disabledConnectorResponse("notion");
  if (disabled) return disabled;
  return new Response(null, { status: 405 });
}

export async function DELETE() {
  const disabled = disabledConnectorResponse("notion");
  if (disabled) return disabled;
  return new Response(null, { status: 405 });
}
