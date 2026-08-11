import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { StudioBrowserError } from "@/lib/studio-browser";
import { isStudioBrowserId } from "@/lib/studio-browser-contract";
import {
  loadStudioBrowserGrantPayload,
  requireStudioBrowserGrant,
  studioBrowserBootstrapHeaders,
  studioBrowserGrantBootstrap,
  studioBrowserGrantCookieName,
} from "@/lib/studio-browser-grants";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; path?: string[] }>;
};

export async function GET(req: Request, context: RouteContext) {
  return serve(req, context, "GET");
}

export async function HEAD(req: Request, context: RouteContext) {
  return serve(req, context, "HEAD");
}

async function serve(
  req: Request,
  { params }: RouteContext,
  method: "GET" | "HEAD",
) {
  const { id, path = [] } = await params;
  if (!isStudioBrowserId(id)) return unavailable();
  const cookieToken = readCookie(req.headers.get("cookie"), studioBrowserGrantCookieName(id));
  if (!cookieToken && path.length === 0 && method === "GET") {
    return new NextResponse(studioBrowserGrantBootstrap(id), {
      headers: studioBrowserBootstrapHeaders(),
    });
  }
  try {
    const db = getDb();
    const grant = await requireStudioBrowserGrant({
      db,
      grantId: id,
      cookieToken,
    });
    const requestUrl = new URL(req.url);
    const payload = await loadStudioBrowserGrantPayload({
      db,
      context: grant,
      pathSegments: path,
      search: requestUrl.search,
      method,
    });
    return new NextResponse(payload.body, {
      status: payload.status,
      headers: payload.headers,
    });
  } catch (error) {
    return unavailable(error instanceof StudioBrowserError ? error.status : 500);
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function unavailable(status = 404) {
  return new NextResponse("This Browser preview is unavailable.", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
