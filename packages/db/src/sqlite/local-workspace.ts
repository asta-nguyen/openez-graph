import fs from "node:fs/promises";
import path from "node:path";

import type { RegistryWorkspace } from "./types";

const OPENEZ_DIRNAME = ".openez";
const WORKSPACE_CONFIG_FILENAME = "workspace.json";

export interface LocalWorkspaceConfig {
  workspaceId: string;
  rootPath: string;
  name: string;
  updatedAt: string;
}

export function getLocalWorkspaceDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), OPENEZ_DIRNAME);
}

export function getLocalWorkspaceConfigPath(rootPath: string): string {
  return path.join(getLocalWorkspaceDir(rootPath), WORKSPACE_CONFIG_FILENAME);
}

export async function writeLocalWorkspaceConfig(workspace: Pick<RegistryWorkspace, "id" | "name" | "rootPath">): Promise<void> {
  const configPath = getLocalWorkspaceConfigPath(workspace.rootPath);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        workspaceId: workspace.id,
        rootPath: workspace.rootPath,
        name: workspace.name,
        updatedAt: new Date().toISOString()
      } satisfies LocalWorkspaceConfig,
      null,
      2
    ) + "\n",
    "utf8"
  );

  await ensureGitignoreEntry(workspace.rootPath, OPENEZ_DIRNAME);
}

const GITIGNORE = ".gitignore";

async function ensureGitignoreEntry(rootPath: string, entry: string): Promise<void> {
  const gitignorePath = path.join(rootPath, GITIGNORE);

  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = content.split("\n");
  const pattern = entry.endsWith("/") ? entry : entry + "/";
  const hasEntry = lines.some(
    (l) => l.trim() === entry || l.trim() === pattern
  );

  if (hasEntry) return;

  const nl = content.endsWith("\n") ? "" : "\n";
  await fs.writeFile(gitignorePath, content + nl + entry + "/\n", "utf8");
}

export async function readLocalWorkspaceConfig(rootPath: string): Promise<LocalWorkspaceConfig | null> {
  const configPath = getLocalWorkspaceConfigPath(rootPath);

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalWorkspaceConfig>;
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.rootPath !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as LocalWorkspaceConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function findLocalWorkspaceConfig(startPath: string): Promise<LocalWorkspaceConfig | null> {
  let currentPath = path.resolve(startPath);

  try {
    const stat = await fs.stat(currentPath);
    if (!stat.isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const config = await readLocalWorkspaceConfig(currentPath);
    if (config) {
      return config;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}
