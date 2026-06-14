import { DEFAULT_MODEL_ID, MODELS } from "@ai-workspace/agent";
import { NextResponse } from "next/server";
import { runtimeV2EnabledFromEnv } from "@/lib/chat-routing";

export const dynamic = "force-dynamic";

interface ApiModel {
  id: string;
  displayName: string;
  blurb: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  contextWindow: number;
  recommendedFor: readonly string[];
}

interface ModelsBody {
  defaultModelId: string;
  models: ApiModel[];
  runtimeV2Enabled: boolean;
}

export async function GET() {
  const body: ModelsBody = {
    defaultModelId: DEFAULT_MODEL_ID,
    runtimeV2Enabled: runtimeV2EnabledFromEnv(),
    models: Object.values(MODELS).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      blurb: model.blurb,
      costPer1MInput: model.costPer1MInput,
      costPer1MOutput: model.costPer1MOutput,
      contextWindow: model.contextWindow,
      recommendedFor: model.recommendedFor,
    })),
  };

  return NextResponse.json(body);
}
