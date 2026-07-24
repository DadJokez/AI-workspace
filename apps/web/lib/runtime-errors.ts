export interface RuntimeErrorContext {
  runtime: string;
  runtimeTarget: string;
  requestedModelId: string;
  modelId: string;
  providerModelId?: string;
}

export interface RuntimeErrorMetadata extends RuntimeErrorContext {
  deniedAction?: string;
  deniedResource?: string;
}

export interface NormalizedRuntimeError {
  code: string;
  category:
    | "runtime_authorization_denied"
    | "model_access_denied"
    | "model_not_found"
    | "provider_error";
  userMessage: string;
  rawMessage: string;
  retryable: boolean;
  metadata: RuntimeErrorMetadata;
}

export function normalizeRuntimeError(
  error: unknown,
  context: RuntimeErrorContext,
): NormalizedRuntimeError {
  const rawMessage = rawErrorMessage(error);
  const lower = rawMessage.toLowerCase();
  const accessDenied = isAccessDenied(lower);
  const authorizationMetadata = accessDenied
    ? extractAuthorizationMetadata(rawMessage)
    : {};
  const metadata = { ...context, ...authorizationMetadata };

  if (
    accessDenied &&
    (lower.includes("bedrock-agentcore") ||
      context.runtime.toLowerCase() === "agentcore")
  ) {
    return {
      code: "agentcore_invoke_access_denied",
      category: "runtime_authorization_denied",
      userMessage:
        "The workspace runtime is unavailable because its AWS permissions are misconfigured. An administrator needs to restore runtime access before this request can run.",
      rawMessage,
      retryable: false,
      metadata,
    };
  }

  if (
    lower.includes("model access is denied") ||
    lower.includes("aws-marketplace") ||
    lower.includes("marketplace subscription") ||
    lower.includes("viewsubscriptions") ||
    lower.includes("accessdeniedexception") ||
    (/not authorized/.test(lower) &&
      /\b(bedrock|aws marketplace|aws-marketplace)\b/.test(lower))
  ) {
    return {
      code: "bedrock_model_access_denied",
      category: "model_access_denied",
      userMessage:
        "This model is not enabled for the AWS Bedrock account backing this workspace. I could not complete the response with the selected runtime model.",
      rawMessage,
      retryable: false,
      metadata,
    };
  }

  if (
    lower.includes("unknown modelid") ||
    lower.includes("unknown model id") ||
    lower.includes("validationexception") ||
    lower.includes("model identifier") ||
    lower.includes("model not found")
  ) {
    return {
      code: "provider_model_not_found",
      category: "model_not_found",
      userMessage:
        "This workspace tried to use a model that is not available to the selected runtime.",
      rawMessage,
      retryable: false,
      metadata,
    };
  }

  return {
    code: "provider_runtime_error",
    category: "provider_error",
    userMessage: rawMessage,
    rawMessage,
    retryable: true,
    metadata,
  };
}

function isAccessDenied(message: string): boolean {
  return /\b(?:accessdenied(?:exception)?|access denied|not authorized)\b/i.test(
    message,
  );
}

function extractAuthorizationMetadata(
  message: string,
): Pick<RuntimeErrorMetadata, "deniedAction" | "deniedResource"> {
  const deniedAction = message.match(
    /\b(?:aws-marketplace|bedrock-agentcore|bedrock):[A-Za-z][A-Za-z0-9]*\b/i,
  )?.[0];
  const deniedResource = message
    .match(/\bon resource(?::|\s)\s*([^\s,;]+)/i)?.[1]
    ?.replace(/[."'`)]+$/, "");
  return {
    ...(deniedAction ? { deniedAction } : {}),
    ...(deniedResource ? { deniedResource } : {}),
  };
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
