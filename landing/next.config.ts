import type { NextConfig } from "next";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const nextConfig: NextConfig = {
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
};

export default nextConfig;
