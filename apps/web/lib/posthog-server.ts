import { PostHog } from "posthog-node";
import { ANALYTICS } from "@/lib/deployment-config";

interface PostHogEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

let client: PostHog | undefined;

/** Undefined when analytics is off: no client is built and nothing is sent. */
function getPostHogClient(): PostHog | undefined {
  if (!ANALYTICS) return undefined;

  if (!client) {
    client = new PostHog(ANALYTICS.token, {
      host: ANALYTICS.host,
      flushAt: 1,
      flushInterval: 0,
    });
    client.on("error", (error) => {
      console.error("[posthog] background delivery failed", error);
    });
  }

  return client;
}

export function capturePostHogEvent(event: PostHogEvent): void {
  try {
    getPostHogClient()?.capture(event);
  } catch (error) {
    console.error(
      `[posthog] failed to capture ${event.event}`,
      error,
    );
  }
}
