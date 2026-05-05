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

/**
 * Canonical user-facing display names keyed by Cursor model id. Cursor's own
 * `displayName` field is sometimes a raw version slug (e.g. "grok-4.3") that
 * leaks through to the UI; we own the rendered label here. If Cursor adds a
 * new model id, the fallback in `cleanDisplayName` derives a label from the id
 * — extend this table when you want a hand-written name.
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  default: "Cursor Default",
  "composer-2": "Cursor Composer 2",
  "composer-1.5": "Cursor Composer 1.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.5": "GPT-5.5",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "grok-4-20": "Grok 4",
  "kimi-k2.5": "Kimi K2.5",
};

/**
 * Best-effort title-case fallback for a Cursor model id we don't have a
 * hand-written name for. Splits on `-`, capitalizes ASCII words, and keeps
 * version-style chunks (anything containing a digit) as-is.
 *   "claude-opus-5-1"  -> "Claude Opus 5 1"
 *   "gpt-6"            -> "GPT-6"
 */
function deriveDisplayName(id: string): string {
  if (!id) return id;
  return id
    .split("-")
    .map((part) => {
      if (!part) return part;
      if (/^gpt$/i.test(part)) return "GPT";
      if (/\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ")
    .replace(/\bGPT\s/g, "GPT-")
    .trim();
}

function cleanDisplayName(id: string): string {
  return DISPLAY_NAME_OVERRIDES[id] ?? deriveDisplayName(id);
}

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
    models: Object.values(MODELS).map((m) => {
      const cursorId = LEGACY_TO_CURSOR[m.id];
      return {
        id: cursorId,
        displayName: cleanDisplayName(cursorId),
        blurb: m.blurb,
        costPer1MInput: m.costPer1MInput,
        costPer1MOutput: m.costPer1MOutput,
        contextWindow: m.contextWindow,
        recommendedFor: m.recommendedFor,
      };
    }),
  };
}

function mapCursorModel(m: SDKModel): ApiModel {
  const local = localMetaFor(m.id);
  return {
    id: m.id,
    displayName: cleanDisplayName(m.id),
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
