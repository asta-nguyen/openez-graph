// Fails when the tool list on the landing page and /docs/mcp drifts from the tools the MCP server
// actually registers. Skips quietly when apps/mcp is absent (landing built on its own).
import { existsSync, readFileSync } from "node:fs";

const coreFile = new URL("../../apps/mcp/src/mcp-core.ts", import.meta.url);
const referenceFile = new URL("../src/app/components/mcp-reference.ts", import.meta.url);

if (!existsSync(coreFile)) {
  console.log("check-mcp-tools: apps/mcp not found, skipping");
  process.exit(0);
}

// tool names are snake_case `name: "…"` lines; parameter and server names never match
const toolNames = (file) =>
  new Set(
    [...readFileSync(file, "utf8").matchAll(/^\s+name: "([a-z]+_[a-z_]+)",?\s*$/gm)].map((m) => m[1]),
  );

const registered = toolNames(coreFile);
const documented = toolNames(referenceFile);
const missing = [...registered].filter((n) => !documented.has(n));
const extra = [...documented].filter((n) => !registered.has(n));

if (missing.length || extra.length) {
  if (missing.length) console.error(`Registered in mcp-core.ts but not documented: ${missing.join(", ")}`);
  if (extra.length) console.error(`Documented but not registered in mcp-core.ts: ${extra.join(", ")}`);
  console.error("Update landing/src/app/components/mcp-reference.ts");
  process.exit(1);
}
console.log(`check-mcp-tools: ${registered.size} tools match`);
