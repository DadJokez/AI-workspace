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
    "/api/chat": [
      "../../node_modules/.pnpm/@napi-rs+canvas*/node_modules/@napi-rs/canvas*/**/*",
    ],
  },
  serverExternalPackages: ["pdf-parse", "postgres"],
};

export default nextConfig;
