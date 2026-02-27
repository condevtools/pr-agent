import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mr-agent/db"],
};

export default nextConfig;
