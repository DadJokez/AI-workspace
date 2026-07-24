import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  type ModelId,
} from "@ai-workspace/agent";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { runtimeV2EnabledFromEnv } from "@/lib/chat-routing";
import {
  enabledModelsForPurpose,
  resolveModelForPurpose,
} from "@/lib/model-registry";

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
  // #300: the picker only offers models enabled for user-facing chat, so a
  // disabled model cannot be selected from the UI either. This route is
  // public and must stay available with no database configured at all
  // (public smoke checks it), so it falls back to the platform override when
  // active and otherwise fails open to the full registry.
  let enabledIds: ModelId[] = PLATFORM_MODEL_OVERRIDE_ID
    ? [PLATFORM_MODEL_OVERRIDE_ID]
    : [...MODEL_IDS];
  let defaultModelId: string = DEFAULT_MODEL_ID;
  try {
    const db = getDb();
    [enabledIds, defaultModelId] = await Promise.all([
      enabledModelsForPurpose(db, "chat"),
      resolveModelForPurpose(db, "chat"),
    ]);
  } catch {
    // No DATABASE_URL (or client init failed): registry defaults.
  }
  const body: ModelsBody = {
    defaultModelId,
    runtimeV2Enabled: runtimeV2EnabledFromEnv(),
    models: enabledIds.map((id) => {
      const model = MODELS[id];
      return {
        id: model.id,
        displayName: model.displayName,
        blurb: model.blurb,
        costPer1MInput: model.costPer1MInput,
        costPer1MOutput: model.costPer1MOutput,
        contextWindow: model.contextWindow,
        recommendedFor: model.recommendedFor,
      };
    }),
  };

  return NextResponse.json(body);
}
