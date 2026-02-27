import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["@mr-agent/db"],
  outputFileTracingRoot: path.join(process.cwd(), "../../"),
};

export default nextConfig;
