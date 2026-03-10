import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(frontendDir, ".."),
  images: {
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
