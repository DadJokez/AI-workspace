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
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(config.externals)
        ? config.externals
        : [config.externals].filter(Boolean);
      externals.push(({ request }, callback) => {
        if (request === "@cursor/sdk" || request?.startsWith("@cursor/sdk/")) {
          return callback(null, "commonjs " + request);
        }
        callback();
      });
      config.externals = externals;
    }
    return config;
  },
};

export default nextConfig;
