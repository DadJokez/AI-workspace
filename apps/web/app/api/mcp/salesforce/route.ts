import { handleSalesforceMcpRequest } from "@/lib/salesforce/mcp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleSalesforceMcpRequest(req);
}

export async function GET(req: Request) {
  return handleSalesforceMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleSalesforceMcpRequest(req);
}
