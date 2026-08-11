import fs from "node:fs";
import path from "node:path";

const START_MARKER = "<!-- openez:start -->";
const END_MARKER = "<!-- openez:end -->";
const MANAGED_BLOCK = `${START_MARKER}

## OpenEZ workflow

- Before code work in a new session, call \`memory_recall\` with 1–3 keywords from the current task.
- Use \`code_query\` before filesystem search and \`code_context\` for symbol/file relationships.
- Call \`memory_write\` after an architectural decision or non-obvious constraint is confirmed.
- Use explicit workspace scope for cross-workspace work.
${END_MARKER}`;

export function installAgentInstructions(
  rootPath: string,
  fileName: "AGENTS.md" | "CLAUDE.md",
): string {
  const instructionsPath = path.join(rootPath, fileName);
  const existing = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, "utf-8")
    : "";
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER, start + START_MARKER.length);
  const next =
    start >= 0 && end >= 0
      ? existing.slice(0, start) + MANAGED_BLOCK + existing.slice(end + END_MARKER.length)
      : existing +
        (existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n") +
        MANAGED_BLOCK +
        "\n";

  if (next !== existing) fs.writeFileSync(instructionsPath, next, "utf-8");
  return instructionsPath;
}
