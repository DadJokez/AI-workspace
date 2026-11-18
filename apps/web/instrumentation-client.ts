import posthog from "posthog-js";
import { sanitizePostHogCapture } from "@/lib/posthog-privacy";
import { readPublicRuntimeConfig } from "@/lib/public-runtime-config";

// Analytics is a deployment setting read from the page, not from the bundle:
// with it off, PostHog is never initialised and nothing is sent.
const analytics = readPublicRuntimeConfig()?.analytics;

if (analytics?.provider === "posthog") {
  posthog.init(analytics.token, {
    api_host: analytics.apiHost,
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
    before_send: sanitizePostHogCapture,
    debug: process.env.NODE_ENV === "development",
  });
}
