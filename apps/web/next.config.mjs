/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: [
    "@ai-workspace/agent",
    "@ai-workspace/auth",
    "@ai-workspace/cursor-runtime",
    "@ai-workspace/db",
  ],
  serverExternalPackages: ["postgres", "@cursor/sdk"],
};

export default nextConfig;
