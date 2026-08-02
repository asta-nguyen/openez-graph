import { createAndStartMcpServer } from "@openez-graph/mcp";

declare const __OPENEZ_BUILD_ID__: string;

export async function startMcpServer(defaultPath: string | undefined, version: string) {
  await createAndStartMcpServer({ defaultPath, version, build: __OPENEZ_BUILD_ID__ });
}
