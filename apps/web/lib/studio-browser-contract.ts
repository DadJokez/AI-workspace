export const STUDIO_BROWSER_VIEWPORT = { width: 1440, height: 900 } as const;
export const STUDIO_BROWSER_SESSION_TTL_SECONDS = 15 * 60;
export const STUDIO_BROWSER_LIVE_VIEW_TTL_SECONDS = 90;
export const STUDIO_BROWSER_GRANT_TTL_SECONDS = 15 * 60;

export type StudioBrowserTargetRequest =
  | {
      kind: "evidence";
      messageId: string;
      sourceNumber: number;
    }
  | { kind: "artifact"; artifactId: string }
  | { kind: "app"; appVersionId: string }
  | { kind: "sandbox"; sandboxId: string; port: number };

export type StudioBrowserAction = "back" | "forward" | "reload";

export function studioBrowserTargetKey(
  target: StudioBrowserTargetRequest,
): string {
  if (target.kind === "evidence") {
    return `evidence:${target.messageId}:${target.sourceNumber}`;
  }
  if (target.kind === "artifact") return `artifact:${target.artifactId}`;
  if (target.kind === "app") return `app:${target.appVersionId}`;
  return `sandbox:${target.sandboxId}:${target.port}`;
}

export interface StudioBrowserSessionResponse {
  id: string;
  threadId: string;
  status: "starting" | "ready" | "stopping" | "stopped" | "expired" | "failed";
  targetKind: "public" | "artifact" | "app" | "sandbox";
  displayUrl: string;
  origin: string;
  expiresAt: string;
  viewport: { width: number; height: number };
  liveView?: {
    signedUrl: string;
    expiresAt: string;
  };
  fallback?: {
    title: string;
    detail: string;
  };
  error?: { code: string; message: string };
}

export function parseStudioBrowserStartRequest(value: unknown): {
  threadId: string;
  target: StudioBrowserTargetRequest;
} {
  if (!isRecord(value) || !isUuid(value.threadId) || !isRecord(value.target)) {
    throw new Error("A thread and supported Browser target are required.");
  }
  const target = value.target;
  if (
    target.kind === "evidence" &&
    isUuid(target.messageId) &&
    Number.isInteger(target.sourceNumber) &&
    (target.sourceNumber as number) > 0
  ) {
    return {
      threadId: value.threadId,
      target: {
        kind: "evidence",
        messageId: target.messageId,
        sourceNumber: target.sourceNumber as number,
      },
    };
  }
  if (target.kind === "artifact" && isUuid(target.artifactId)) {
    return {
      threadId: value.threadId,
      target: { kind: "artifact", artifactId: target.artifactId },
    };
  }
  if (target.kind === "app" && isUuid(target.appVersionId)) {
    return {
      threadId: value.threadId,
      target: { kind: "app", appVersionId: target.appVersionId },
    };
  }
  if (
    target.kind === "sandbox" &&
    isUuid(target.sandboxId) &&
    isAllowedSandboxPort(target.port)
  ) {
    return {
      threadId: value.threadId,
      target: {
        kind: "sandbox",
        sandboxId: target.sandboxId,
        port: target.port,
      },
    };
  }
  throw new Error("The requested Browser target is invalid or unsupported.");
}

export function parseStudioBrowserAction(value: unknown): StudioBrowserAction {
  if (
    isRecord(value) &&
    (value.action === "back" ||
      value.action === "forward" ||
      value.action === "reload")
  ) {
    return value.action;
  }
  throw new Error("Browser action must be back, forward, or reload.");
}

export function isAllowedSandboxPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535
  );
}

export function isStudioBrowserId(value: unknown): value is string {
  return isUuid(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
