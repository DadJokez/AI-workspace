import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { updateRecommendationStatus } from "@/lib/recommendation-persistence";
import type { RecommendationStatus } from "@/lib/recommendations";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const sessionUser = session.user;

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { status?: unknown };
    if (body.status !== "accepted" && body.status !== "dismissed") {
      return NextResponse.json(
        { error: "invalid_status", message: "Use accepted or dismissed." },
        { status: 400 },
      );
    }

    const recommendation = await updateRecommendationStatus({
      db: getDb(),
      userId: sessionUser.id,
      recommendationId: id,
      status: body.status as RecommendationStatus,
    });
    if (!recommendation) {
      return NextResponse.json(
        { error: "recommendation_not_found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ recommendation });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
