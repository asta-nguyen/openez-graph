import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
};

export default nextConfig;
