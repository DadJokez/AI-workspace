import { handleGoogleMcpRequest } from "@/lib/google/mcp";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleGoogleMcpRequest(req);
}

export async function GET(req: Request) {
  return handleGoogleMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleGoogleMcpRequest(req);
}
