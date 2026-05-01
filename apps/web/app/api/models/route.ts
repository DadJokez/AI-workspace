import { DEFAULT_MODEL_ID, MODELS } from "@ai-workspace/agent";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Surfaces the model registry to the client so the chat UI can render the
 * model selector without hard-coding the list.
 */
export function GET() {
  const models = Object.values(MODELS).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    blurb: m.blurb,
    costPer1MInput: m.costPer1MInput,
    costPer1MOutput: m.costPer1MOutput,
    contextWindow: m.contextWindow,
    recommendedFor: m.recommendedFor,
  }));

  return NextResponse.json({
    defaultModelId: DEFAULT_MODEL_ID,
    models,
  });
}
