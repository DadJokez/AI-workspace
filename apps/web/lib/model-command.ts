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
 * never needs a parallel hand table here (#797 P1). Per registered model:
 * its id, its display-name slug, its bare short name, and
 * `<family>-<short>` (`claude-sonnet`) when the two differ. A short name
 * shared by several models resolves to the app default when it is one of
 * them, otherwise to the last-registered (newest) model. Three role words
 * follow the registry's own cost/capability ordering
 * (`apps/web/lib/model-registry.ts`): `fast` → cheapest, `deep` → highest
 * output price, `quality` → the app default. Enablement is not this parser's
 * concern — a disabled model resolves here exactly like a raw id and is
 * refused downstream by the enablement gate.
 *
 * Role words range only over models sharing the default model's vendor: a
 * role word means a cheaper or heavier lane of the brain you are on, never a
 * silent vendor swap (#797 P3 — a registered-but-disabled Nova Pro would
 * otherwise become `fast` by price). Crossing vendors is an explicit
 * `/model nova`.
 */
function buildModelAliases(): Record<string, ModelId | "auto"> {
  const aliases: Record<string, ModelId | "auto"> = {
    auto: "auto",
    autopilot: "auto",
    default: "auto",
  };
  for (const id of MODEL_IDS) {
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
  const sameVendor = MODEL_IDS.filter(
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

const MODEL_ALIASES = buildModelAliases();

/** Registry-derived `/model` aliases; exported for tests and help text. */
export function modelCommandAliases(): Readonly<Record<string, ModelId | "auto">> {
  return MODEL_ALIASES;
}

export function isModelCommandInput(input: string): boolean {
  return /^\/model(?:\s|$)/i.test(input.trimStart());
}

export function parseModelCommand(input: string): ParsedModelCommand | null {
  const match = MODEL_COMMAND_RE.exec(input.trimStart());
  if (!match) return null;

  const rawModel = (match[1] ?? "").trim().toLowerCase();
  const body = (match[2] ?? "").trimStart();
  if (!rawModel) return null;

  const mapped = MODEL_ALIASES[rawModel];
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

export function modelCommandUsageMessage(): string {
  const shortNames = [...new Set(MODEL_IDS.map(shortName))];
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
