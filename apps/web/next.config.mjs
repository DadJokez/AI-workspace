const pdfRuntimeTraceIncludes = [
  "../../node_modules/.pnpm/@napi-rs+canvas*/node_modules/@napi-rs/canvas*/**/*",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/**/*",
];

// `next dev` is the only mode that needs eval (HMR/react-refresh). Anything
// that isn't explicitly development gets the tighter policy — an unset
// NODE_ENV must not silently hand out 'unsafe-eval'.
const isDevServer = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy derived from what this app actually loads:
 *   - scripts/styles: all first-party. `'unsafe-inline'` is still required —
 *     Next.js inlines its bootstrap + flight payload, and app/layout.tsx
 *     inlines the pre-paint theme script. Dropping it needs a nonce threaded
 *     through middleware (follow-up, not this PR).
 *   - PostHog is same-origin: the `/ingest/*` rewrites below proxy it, and
 *     instrumentation-client.ts sets `api_host: "/ingest"`, so no posthog.com
 *     origin appears here.
 *   - `data:`/`blob:` images and media: artifact previews render base64 data
 *     URLs and downloads go through URL.createObjectURL.
 *   - fonts are local woff2 under /app/fonts (no Google Fonts egress).
 *
 * `frameAncestors` is the only knob: everything except the deployed-app
 * document refuses framing outright.
 */
function contentSecurityPolicy(frameAncestors) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${isDevServer ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/**
 * Baseline security headers for every response.
 *
 * The CSP ships REPORT-ONLY on purpose: the policy above is derived by
 * reading the app, not by observing it, so it soaks in report-only until the
 * violation reports come back clean. Flipping to enforcement is a one-word
 * change of this key (see the PR body for the rollout).
 */
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy-Report-Only",
    value: contentSecurityPolicy("'none'"),
  },
];

/**
 * The one framing exemption: `/apps/<slug>` (app/apps/[slug]/route.ts) serves
 * a deployed app and already sends its own ENFORCING CSP with
 * `frame-ancestors 'self'` — that document is meant to be embeddable by the
 * workspace itself. A blanket `X-Frame-Options: DENY` would contradict it, so
 * this path gets SAMEORIGIN and a matching report-only policy instead.
 * Header rules are applied in order and a later rule overwrites an earlier
 * one for the same key, so this entry must stay last. Nothing else is
 * relaxed: the route's own nosniff / referrer-policy / CSP still win over
 * these, because route-handler headers are written after config headers.
 */
const deployedAppHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Content-Security-Policy-Report-Only",
    value: contentSecurityPolicy("'self'"),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: [
    "@ai-workspace/agent",
    "@ai-workspace/auth",
    "@ai-workspace/agent-runtime",
    "@ai-workspace/db",
    "@ai-workspace/umber",
  ],
  outputFileTracingIncludes: {
    "/api/chat": pdfRuntimeTraceIncludes,
    "/api/mcp/resources": pdfRuntimeTraceIncludes,
  },
  serverExternalPackages: ["pdf-parse", "postgres"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/apps/:slug", headers: deployedAppHeaders },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
