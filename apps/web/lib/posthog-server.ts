import { PostHog } from "posthog-node";

interface PostHogEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

let client: PostHog | undefined;
let warnedAboutMissingToken = false;

function getPostHogClient(): PostHog | undefined {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) {
    if (
      process.env.NODE_ENV === "development" &&
      !warnedAboutMissingToken
    ) {
      warnedAboutMissingToken = true;
      console.warn(
        "[posthog] analytics disabled: NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not configured",
      );
    }
    return undefined;
  }

  if (!client) {
    client = new PostHog(token, {
      host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ??
        "https://us.i.posthog.com",
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
