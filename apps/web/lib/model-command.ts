import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  type ModelId,
} from "@ai-workspace/agent";

export type ChatModelOverride =
  | { mode: "model"; modelId: ModelId; label: string }
  | { mode: "auto"; label: "auto" };

export interface ParsedModelCommand {
  override: ChatModelOverride;
  body: string;
}

const MODEL_COMMAND_RE = /^\/model(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

/** "Sonnet 4.6" → "sonnet-4-6"; "Nova Pro" → "nova-pro". */
function displayNameSlug(modelId: ModelId): string {
  return MODELS[modelId].displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** First word of the display name: "sonnet", "opus", "nova". */
function shortName(modelId: ModelId): string {
  return displayNameSlug(modelId).split("-")[0]!;
}

/**
 * `/model <alias>` vocabulary, derived from the registry so adding a model
 * never needs a parallel hand table here (#797 P1). Per model in `modelIds`:
 * its id, its display-name slug, its bare short name, and
 * `<family>-<short>` (`claude-sonnet`) when the two differ. A short name
 * shared by several models resolves to the app default when it is one of
 * them, otherwise to the last-listed (newest) model. Three role words
 * follow the registry's own cost/capability ordering
 * (`apps/web/lib/model-registry.ts`): `fast` → cheapest, `deep` → highest
 * output price, `quality` → the app default.
 *
 * Role words range only over models sharing the default model's vendor: a
 * role word means a cheaper or heavier lane of the brain you are on, never a
 * silent vendor swap (#797 P3 — a registered-but-disabled Nova Pro would
 * otherwise become `fast` by price). Crossing vendors is an explicit
 * `/model nova`.
 *
 * `modelIds` is the vocabulary. The default is the whole registry (the pure,
 * enablement-blind table tests and the composer use); the chat route passes
 * the models enabled for chat instead (#797 P5), so a registered-but-
 * disabled brain can neither be named nor capture a shared short name or a
 * role word from an enabled one — with ten disabled entries registered,
 * `opus` and `deep` would otherwise resolve to Opus 5 / Fable 5.1 and the
 * enablement gate would silently answer on the default. The parser itself
 * stays sync and pure; enablement is the caller's input, never a lookup here.
 */
function buildModelAliases(
  modelIds: readonly ModelId[],
): Record<string, ModelId | "auto"> {
  const aliases: Record<string, ModelId | "auto"> = {
    auto: "auto",
    autopilot: "auto",
    default: "auto",
  };
  for (const id of modelIds) {
    const short = shortName(id);
    aliases[id] = id;
    aliases[displayNameSlug(id)] = id;
    aliases[short] = id;
    if (MODELS[id].family !== short) {
      aliases[`${MODELS[id].family}-${short}`] = id;
    }
  }
  const defaultShort = shortName(DEFAULT_MODEL_ID);
  aliases[defaultShort] = DEFAULT_MODEL_ID;
  if (MODELS[DEFAULT_MODEL_ID].family !== defaultShort) {
    aliases[`${MODELS[DEFAULT_MODEL_ID].family}-${defaultShort}`] =
      DEFAULT_MODEL_ID;
  }

  const cost = (id: ModelId) =>
    MODELS[id].costPer1MInput + MODELS[id].costPer1MOutput;
  const sameVendor = modelIds.filter(
    (id) => MODELS[id].provider === MODELS[DEFAULT_MODEL_ID].provider,
  );
  let cheapest: ModelId = DEFAULT_MODEL_ID;
  let deepest: ModelId = DEFAULT_MODEL_ID;
  for (const id of sameVendor) {
    if (cost(id) < cost(cheapest)) cheapest = id;
    if (MODELS[id].costPer1MOutput > MODELS[deepest].costPer1MOutput) {
      deepest = id;
    }
  }
  aliases.fast = cheapest;
  aliases.deep = deepest;
  aliases.quality = DEFAULT_MODEL_ID;
  return aliases;
}

const REGISTRY_ALIASES = buildModelAliases(MODEL_IDS);

function aliasesFor(
  modelIds: readonly ModelId[],
): Record<string, ModelId | "auto"> {
  return modelIds === MODEL_IDS ? REGISTRY_ALIASES : buildModelAliases(modelIds);
}

/** Registry-derived `/model` aliases over `modelIds`; exported for tests and help text. */
export function modelCommandAliases(
  modelIds: readonly ModelId[] = MODEL_IDS,
): Readonly<Record<string, ModelId | "auto">> {
  return aliasesFor(modelIds);
}

export function isModelCommandInput(input: string): boolean {
  return /^\/model(?:\s|$)/i.test(input.trimStart());
}

export function parseModelCommand(
  input: string,
  modelIds: readonly ModelId[] = MODEL_IDS,
): ParsedModelCommand | null {
  const match = MODEL_COMMAND_RE.exec(input.trimStart());
  if (!match) return null;

  const rawModel = (match[1] ?? "").trim().toLowerCase();
  const body = (match[2] ?? "").trimStart();
  if (!rawModel) return null;

  const mapped = aliasesFor(modelIds)[rawModel];
  if (!mapped) return null;

  if (mapped === "auto") {
    return {
      override: { mode: "auto", label: "auto" },
      body,
    };
  }

  return {
    override: {
      mode: "model",
      modelId: mapped,
      label: rawModel,
    },
    body,
  };
}

export function modelCommandUsageMessage(
  modelIds: readonly ModelId[] = MODEL_IDS,
): string {
  const shortNames = [...new Set(modelIds.map(shortName))];
  return `Use ${shortNames.map((name) => `/model ${name}`).join(", ")}, or /model auto followed by a message.`;
}

export function buildModelCommandDisplayMessage(
  override: ChatModelOverride,
  body: string,
): string {
  const token =
    override.mode === "model" ? override.label || override.modelId : "auto";
  const trimmedBody = body.trim();
  return trimmedBody ? `/model ${token} ${trimmedBody}` : `/model ${token}`;
}
