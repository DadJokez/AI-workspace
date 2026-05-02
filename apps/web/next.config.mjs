/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@ai-workspace/agent", "@ai-workspace/auth"],
};

export default nextConfig;
