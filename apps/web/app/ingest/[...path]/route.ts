import { proxyPostHogIngest } from "@/lib/posthog-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ path: string[] }> };

async function handle(req: Request, { params }: Context) {
  return proxyPostHogIngest(req, (await params).path);
}

export { handle as GET, handle as POST, handle as OPTIONS };
