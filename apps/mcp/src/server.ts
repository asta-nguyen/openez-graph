import { createAndStartMcpServer } from "./mcp-core";

const defaultPath = process.argv.includes("--path")
  ? process.argv[process.argv.indexOf("--path") + 1]
  : undefined;

createAndStartMcpServer({ defaultPath }).catch((error) => {
  console.error(error);
  process.exit(1);
});
