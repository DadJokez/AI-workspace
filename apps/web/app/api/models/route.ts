import { DEFAULT_MODEL_ID, MODELS, type ModelId } from "@ai-workspace/agent";
import {
  listCursorModels,
  type SDKModel,
} from "@ai-workspace/cursor-runtime";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Surfaces the model registry to the client. Source of truth is the Cursor
 * SDK's `Cursor.models.list()` — that's what determines which model ids the
 * agent runtime can actually run. We layer our local `MODELS` registry on top
 * for cost / context-window / blurb metadata, keyed by the Cursor model id
 * (via the legacy-short-id → Cursor-id table below).
 *
 * Cached for 5 minutes to avoid hammering Cursor on every page load. On any
 * fetch error we fall back to the static `MODELS` registry so the UI doesn't
 * break if Cursor is briefly unreachable.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; body: unknown } | null = null;

const LEGACY_TO_CURSOR: Record<ModelId, string> = {
  "haiku-4-5": "claude-haiku-4-5-20251001",
  "sonnet-4-6": "claude-sonnet-4-6",
  "opus-4-7": "claude-opus-4-7",
};

interface ApiModel {
  id: string;
  displayName: string;
  blurb: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  contextWindow: number;
  recommendedFor: readonly string[];
}

function localMetaFor(cursorId: string) {
  for (const m of Object.values(MODELS)) {
    if (LEGACY_TO_CURSOR[m.id] === cursorId) return m;
  }
  return null;
}

function fallbackBody(): { defaultModelId: string; models: ApiModel[] } {
  return {
    defaultModelId: LEGACY_TO_CURSOR[DEFAULT_MODEL_ID],
    models: Object.values(MODELS).map((m) => ({
      id: LEGACY_TO_CURSOR[m.id],
      displayName: m.displayName,
      blurb: m.blurb,
      costPer1MInput: m.costPer1MInput,
      costPer1MOutput: m.costPer1MOutput,
      contextWindow: m.contextWindow,
      recommendedFor: m.recommendedFor,
    })),
  };
}

function mapCursorModel(m: SDKModel): ApiModel {
  const local = localMetaFor(m.id);
  return {
    id: m.id,
    displayName: m.displayName,
    blurb: local?.blurb ?? m.description ?? "",
    // We don't have authoritative cost numbers for models outside the local
    // registry. Default to 0 so the UI doesn't crash; future cost-tracking
    // work needs a real source of truth here.
    costPer1MInput: local?.costPer1MInput ?? 0,
    costPer1MOutput: local?.costPer1MOutput ?? 0,
    contextWindow: local?.contextWindow ?? 0,
    recommendedFor: local?.recommendedFor ?? [],
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  let cursorModels: SDKModel[];
  try {
    cursorModels = await listCursorModels(process.env.CURSOR_API_KEY);
  } catch {
    return NextResponse.json(fallbackBody());
  }

  if (!cursorModels?.length) {
    return NextResponse.json(fallbackBody());
  }

  const fallbackDefault = LEGACY_TO_CURSOR[DEFAULT_MODEL_ID];
  const defaultModelId =
    cursorModels.find((m) => m.id === fallbackDefault)?.id ??
    cursorModels[0]!.id;

  const body = {
    defaultModelId,
    models: cursorModels.map(mapCursorModel),
  };
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
