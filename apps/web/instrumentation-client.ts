import posthog from "posthog-js";

if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) {
  if (process.env.NODE_ENV === "development") {
    console.warn(
      "[posthog] analytics disabled: NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is not configured",
    );
  }
} else {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
    debug: process.env.NODE_ENV === "development",
  });
}
