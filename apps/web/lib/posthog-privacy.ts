import type { BeforeSendFn, CaptureResult } from "posthog-js";
import { analyticsPathFor } from "@/lib/posthog-path";

type AnalyticsProperties = CaptureResult["properties"];

function safeAnalyticsUrl(value: string): string | undefined {
  try {
    const url = new URL(value, "https://analytics.invalid");
    const safePath = analyticsPathFor(url.pathname);

    return url.origin === "https://analytics.invalid"
      ? safePath
      : `${url.origin}${safePath}`;
  } catch {
    return undefined;
  }
}

function sanitizeAnalyticsProperties(
  properties: AnalyticsProperties | undefined,
): AnalyticsProperties | undefined {
  if (!properties) return properties;

  const sanitized = { ...properties };
  for (const [key, value] of Object.entries(sanitized)) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey.includes("referrer")) {
      delete sanitized[key];
      continue;
    }

    if (normalizedKey.includes("pathname")) {
      if (typeof value === "string") {
        sanitized[key] = analyticsPathFor(value);
      } else {
        delete sanitized[key];
      }
      continue;
    }

    if (
      normalizedKey === "url" ||
      normalizedKey.endsWith("_url") ||
      normalizedKey === "$current_url"
    ) {
      const safeUrl =
        typeof value === "string" ? safeAnalyticsUrl(value) : undefined;
      if (safeUrl) {
        sanitized[key] = safeUrl;
      } else {
        delete sanitized[key];
      }
    }
  }

  return sanitized;
}

export const sanitizePostHogCapture: BeforeSendFn = (capture) => {
  if (!capture) return null;

  return {
    ...capture,
    properties: sanitizeAnalyticsProperties(capture.properties) ?? {},
    ...(capture.$set
      ? { $set: sanitizeAnalyticsProperties(capture.$set) }
      : {}),
    ...(capture.$set_once
      ? { $set_once: sanitizeAnalyticsProperties(capture.$set_once) }
      : {}),
  };
};
