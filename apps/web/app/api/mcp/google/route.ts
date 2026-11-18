import { disabledConnectorResponse } from "@/lib/deployment-config";
import { handleGoogleMcpRequest } from "@/lib/google/mcp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const disabled = disabledConnectorResponse("google");
  if (disabled) return disabled;
  return handleGoogleMcpRequest(req);
}

export async function GET(req: Request) {
  const disabled = disabledConnectorResponse("google");
  if (disabled) return disabled;
  return handleGoogleMcpRequest(req);
}

export async function DELETE(req: Request) {
  const disabled = disabledConnectorResponse("google");
  if (disabled) return disabled;
  return handleGoogleMcpRequest(req);
}
