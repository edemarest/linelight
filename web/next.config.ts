import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    turbo: {
      root: "/app",
    },
  },
};

export default nextConfig;
