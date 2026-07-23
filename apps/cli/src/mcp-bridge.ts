import { createAndStartMcpServer } from "@openez-graph/mcp";

export async function startMcpServer(defaultPath?: string) {
  await createAndStartMcpServer({ defaultPath });
}
