import { createAndStartMcpServer } from "../../mcp/src/mcp-core";

export async function startMcpServer(defaultPath?: string) {
  await createAndStartMcpServer({ defaultPath });
}
