import fs from "node:fs";
import path from "node:path";

const START_MARKER = "<!-- openez:start -->";
const END_MARKER = "<!-- openez:end -->";
const MANAGED_BLOCK = `${START_MARKER}

## OpenEZ workflow

- Before code work in a new session, call \`memory_recall\` with 1–3 keywords from the current task.
- Use \`code_query\` before filesystem search and \`code_context\` for symbol or file follow-up.
- Use \`graph_neighbors\` for relationship lookups between symbols, files, and edges.
- Call \`memory_write\` after an architectural decision or non-obvious constraint is confirmed.
- Use explicit workspace scope for cross-workspace work.
${END_MARKER}`;

export function installAgentInstructions(
  rootPath: string,
  fileName: "AGENTS.md" | "CLAUDE.md",
): string {
  const instructionsPath = path.join(rootPath, fileName);

  // Reject symlinks before any read or write so a check/write race cannot
  // modify a target outside rootPath. lstatSync does not follow symlinks.
  try {
    const stats = fs.lstatSync(instructionsPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Refusing to manage symlinked instruction file: " + instructionsPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const existing = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, "utf-8")
    : "";

  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  const hasStart = start >= 0;
  const hasEnd = end >= 0;
  if (hasStart !== hasEnd) {
    throw new Error(
      "Unmatched OpenEZ managed-block marker in " +
        fileName +
        ": found " +
        (hasStart ? "START without END" : "END without START") +
        ". Fix the file manually or remove both markers.",
    );
  }
  if (hasStart && end < start) {
    throw new Error(
      `Invalid OpenEZ managed-block marker order in ${fileName}: END appears before START.`,
    );
  }

  const next =
    hasStart && hasEnd
      ? existing.slice(0, start) + MANAGED_BLOCK + existing.slice(end + END_MARKER.length)
      : existing +
        (existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n") +
        MANAGED_BLOCK +
        "\n";

  if (next !== existing) fs.writeFileSync(instructionsPath, next, "utf-8");
  return instructionsPath;
}
