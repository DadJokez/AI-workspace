export class ClientApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

interface ApiErrorEnvelope {
  error?: unknown;
  code?: unknown;
  field?: unknown;
  message?: unknown;
}

export async function readApiError(
  response: Response,
  fallbackMessage?: string,
): Promise<ClientApiError> {
  const body = await readErrorEnvelope(response);
  const code = optionalString(body?.error) ?? optionalString(body?.code);
  const field = optionalString(body?.field);
  const message =
    optionalString(body?.message) ??
    (code ? humanizeApiCode(code) : undefined) ??
    fallbackMessage ??
    `Request failed (HTTP ${response.status}).`;

  return new ClientApiError(message, response.status, code, field);
}

export async function throwApiError(
  response: Response,
  fallbackMessage?: string,
): Promise<never> {
  throw await readApiError(response, fallbackMessage);
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallbackMessage?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (!fallbackMessage) throw error;
    throw new ClientApiError(fallbackMessage, 0);
  }
  if (!response.ok) {
    return throwApiError(response, fallbackMessage);
  }
  return (await response.json()) as T;
}

function humanizeApiCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return code;
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

async function readErrorEnvelope(
  response: Response,
): Promise<ApiErrorEnvelope | null> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object"
      ? (body as ApiErrorEnvelope)
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
