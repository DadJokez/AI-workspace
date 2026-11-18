/**
 * Deployment settings the browser needs. The root layout writes them into the
 * page as JSON at request time, so the same image serves any deployment. Only
 * values that are public by nature belong here.
 */
export type PublicRuntimeConfig = {
  /** Null when analytics is off for this deployment. */
  analytics: { provider: "posthog"; token: string; apiHost: string } | null;
  /** Connector provider ids this deployment offers. */
  connectors: string[];
};

export const PUBLIC_RUNTIME_CONFIG_ELEMENT_ID = "comparative-runtime-config";

/** `<` is escaped so a value can never close the script element. */
export function serializePublicRuntimeConfig(
  config: PublicRuntimeConfig,
): string {
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

/** Browser only. Null on the server or when the element is missing. */
export function readPublicRuntimeConfig(): PublicRuntimeConfig | null {
  if (typeof document === "undefined") return null;
  const text = document.getElementById(
    PUBLIC_RUNTIME_CONFIG_ELEMENT_ID,
  )?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as PublicRuntimeConfig;
  } catch {
    return null;
  }
}
