import type { AgentEvent, ModelId } from "@ai-workspace/agent";
import type {
  AgentRuntime,
  TurnInput,
} from "@ai-workspace/agent-runtime";

export interface ModelFailoverTransition {
  fromModelId: ModelId;
  toModelId: ModelId;
  error: string;
  attempt: number;
}

/**
 * Runs enabled model candidates in order, but only retries before an attempt
 * emits anything that could be visible or cause a side effect.
 */
export async function* runTurnWithModelFailover({
  runtime,
  input,
  candidates,
  onFailover,
}: {
  runtime: AgentRuntime;
  input: TurnInput;
  candidates: readonly ModelId[];
  onFailover?: (
    transition: ModelFailoverTransition,
  ) => void | Promise<void>;
}): AsyncGenerator<AgentEvent, void, void> {
  const ordered = uniqueCandidates(candidates);
  if (ordered.length === 0) {
    throw new Error("Model failover requires at least one candidate.");
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const modelId = ordered[index]!;
    const nextModelId = ordered[index + 1];
    let attemptCommitted = false;
    let transition: ModelFailoverTransition | undefined;

    try {
      for await (const event of runtime.runTurn({ ...input, modelId })) {
        if (
          event.type === "error" &&
          // #713: a degraded MCP mount is a provider-side problem the turn
          // already recovered from — switching models would just re-dial the
          // same dead provider.
          !event.degradedProvider &&
          !attemptCommitted &&
          nextModelId &&
          isModelFailoverEligibleError(event.message)
        ) {
          transition = {
            fromModelId: modelId,
            toModelId: nextModelId,
            error: event.message,
            attempt: index + 1,
          };
          break;
        }

        if (commitsModelAttempt(event)) attemptCommitted = true;
        yield event;
      }
    } catch (error) {
      const message = errorMessage(error);
      if (
        !attemptCommitted &&
        nextModelId &&
        isModelFailoverEligibleError(message)
      ) {
        transition = {
          fromModelId: modelId,
          toModelId: nextModelId,
          error: message,
          attempt: index + 1,
        };
      } else {
        throw error;
      }
    }

    if (transition) {
      await onFailover?.(transition);
      continue;
    }
    return;
  }
}

export function isModelFailoverEligibleError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("bedrock-agentcore") && isAccessDenied(message)) {
    return false;
  }

  return (
    /\bthrottl(?:e|ed|ing)(?:exception)?\b/.test(message) ||
    /\b(?:rate[\s_-]?limit|too many requests)\b/.test(message) ||
    /\b429\b/.test(message) ||
    /\b(?:service unavailable|temporarily unavailable|overloaded|capacity)\b/.test(
      message,
    ) ||
    /\b(?:serviceunavailable|modelnotready|internalserver)exception\b/.test(
      message,
    ) ||
    message.includes("model access is denied") ||
    message.includes("marketplace subscription") ||
    message.includes("aws-marketplace") ||
    message.includes("unknown modelid") ||
    message.includes("unknown model id") ||
    message.includes("model not found") ||
    (message.includes("validationexception") && message.includes("model")) ||
    (isAccessDenied(message) &&
      message.includes("bedrock") &&
      message.includes("model"))
  );
}

function commitsModelAttempt(event: AgentEvent): boolean {
  return (
    event.type !== "provider-request" &&
    event.type !== "provider-response-metadata" &&
    event.type !== "error"
  );
}

function uniqueCandidates(candidates: readonly ModelId[]): ModelId[] {
  return [...new Set(candidates)];
}

function isAccessDenied(message: string): boolean {
  return /\b(?:accessdenied(?:exception)?|access denied|not authorized)\b/.test(
    message,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
