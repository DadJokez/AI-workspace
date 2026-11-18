import { disabledConnectorResponse } from "@/lib/deployment-config";
import { handleSalesforceMcpRequest } from "@/lib/salesforce/mcp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const disabled = disabledConnectorResponse("salesforce");
  if (disabled) return disabled;
  return handleSalesforceMcpRequest(req);
}

export async function GET(req: Request) {
  const disabled = disabledConnectorResponse("salesforce");
  if (disabled) return disabled;
  return handleSalesforceMcpRequest(req);
}

export async function DELETE(req: Request) {
  const disabled = disabledConnectorResponse("salesforce");
  if (disabled) return disabled;
  return handleSalesforceMcpRequest(req);
}
