"use client";

import { analyticsPathFor } from "@/lib/posthog-path";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect } from "react";

export function PostHogPageView() {
  const pathname = usePathname();

  useEffect(() => {
    const safePath = analyticsPathFor(pathname);
    posthog.capture("$pageview", {
      $current_url: `${window.location.origin}${safePath}`,
    });
  }, [pathname]);

  return null;
}
