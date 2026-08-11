import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { StudioBrowserError } from "@/lib/studio-browser";
import { isStudioBrowserId } from "@/lib/studio-browser-contract";
import {
  authorizeStudioBrowserGrant,
  studioBrowserGrantCookieName,
} from "@/lib/studio-browser-grants";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isStudioBrowserId(id)) return unavailable();
  try {
    const body = (await req.json()) as { grant?: unknown };
    if (typeof body.grant !== "string") return unavailable();
    const now = new Date();
    const context = await authorizeStudioBrowserGrant({
      db: getDb(),
      grantId: id,
      token: body.grant,
      now,
    });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(studioBrowserGrantCookieName(id), body.grant, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: `/api/studio/browser/grants/${id}`,
      maxAge: Math.max(
        1,
        Math.floor((context.grant.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    });
    return response;
  } catch (error) {
    if (error instanceof StudioBrowserError) return unavailable(error.status);
    return unavailable();
  }
}

function unavailable(status = 404) {
  return NextResponse.json(
    { error: "browser_grant_unavailable" },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
