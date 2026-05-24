import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: ["@openez-graph/config", "@openez-graph/db", "@openez-graph/ui"],
  typedRoutes: true,
  outputFileTracingRoot: path.join(__dirname, "../../")
};

export default nextConfig;
