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
  ],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
