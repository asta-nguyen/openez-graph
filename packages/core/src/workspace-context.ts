import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createWorkspaceRepository, type RegistryWorkspace } from "@openez-graph/db";

const execFileAsync = promisify(execFile);
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface WorkspaceContextSnapshot {
  index: {
    status: RegistryWorkspace["status"];
    indexingStatus: RegistryWorkspace["indexingStatus"];
    lastIndexedAt?: string;
    documentCount: number;
    chunkCount: number;
  };
  instructions: Array<{
    path: (typeof INSTRUCTION_FILES)[number];
    content: string;
  }>;
  activity: {
    branch?: string;
    detachedHead?: string;
    changedFiles: Array<{ path: string; status: string }>;
  };
  memories: Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    source: string;
    updatedAt: string;
  }>;
  warnings?: string[];
}

async function runGit(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
  });
  return String(stdout);
}

function parseGitStatus(output: string): Array<{ path: string; status: string }> {
  const records = output.split("\0");
  const files: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    files.push({ path: record.slice(3), status });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return files;
}

export async function workspaceContext(
  workspace: RegistryWorkspace,
): Promise<WorkspaceContextSnapshot> {
  const warnings: string[] = [];
  const instructions: WorkspaceContextSnapshot["instructions"] = [];

  for (const fileName of INSTRUCTION_FILES) {
    const instructionPath = path.join(workspace.rootPath, fileName);
    try {
      const stat = await fs.lstat(instructionPath);
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symlinked instruction file: ${fileName}`);
      } else if (stat.isFile()) {
        instructions.push({ path: fileName, content: await fs.readFile(instructionPath, "utf8") });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const activity: WorkspaceContextSnapshot["activity"] = { changedFiles: [] };
  try {
    const [branchOutput, statusOutput] = await Promise.all([
      runGit(workspace.rootPath, ["branch", "--show-current"]),
      runGit(workspace.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const branch = branchOutput.trim();
    if (branch) activity.branch = branch;
    else
      activity.detachedHead = (
        await runGit(workspace.rootPath, ["rev-parse", "--short", "HEAD"])
      ).trim();
    activity.changedFiles = parseGitStatus(statusOutput);
  } catch {
    warnings.push("Git context unavailable at the registered workspace root.");
  }

  const memories = (await createWorkspaceRepository(workspace.rootPath).listActiveMemories(10)).map(
    (memory) => ({
      id: memory.id,
      title: memory.title,
      content: memory.content,
      tags: memory.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      source: memory.source,
      updatedAt: memory.updatedAt,
    }),
  );

  return {
    index: {
      status: workspace.status,
      indexingStatus: workspace.indexingStatus,
      ...(workspace.lastIndexedAt ? { lastIndexedAt: workspace.lastIndexedAt } : {}),
      documentCount: workspace.documentCount,
      chunkCount: workspace.chunkCount,
    },
    instructions,
    activity,
    memories,
    ...(warnings.length ? { warnings } : {}),
  };
}
