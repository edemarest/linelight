import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@linelight/core"],
  turbopack: {
    root: "/app",
  },
};

export default nextConfig;
