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

export async function writeLocalWorkspaceConfig(
  workspace: Pick<RegistryWorkspace, "id" | "name" | "rootPath">,
): Promise<void> {
  const configPath = getLocalWorkspaceConfigPath(workspace.rootPath);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await Bun.write(
    configPath,
    JSON.stringify(
      {
        workspaceId: workspace.id,
        rootPath: workspace.rootPath,
        name: workspace.name,
        updatedAt: new Date().toISOString(),
      } satisfies LocalWorkspaceConfig,
      null,
      2,
    ) + "\n",
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
    // SAFETY: fs.readFile rejects with a NodeJS.ErrnoException for ENOENT;
    // the cast narrows the unknown error to access the `code` property.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = content.split("\n");
  const pattern = entry.endsWith("/") ? entry : entry + "/";
  const hasEntry = lines.some((l) => l.trim() === entry || l.trim() === pattern);

  if (hasEntry) return;

  const nl = content.endsWith("\n") ? "" : "\n";
  await Bun.write(gitignorePath, content + nl + entry + "/\n");
}

export async function readLocalWorkspaceConfig(
  rootPath: string,
): Promise<LocalWorkspaceConfig | null> {
  const configPath = getLocalWorkspaceConfigPath(rootPath);

  try {
    const raw = await fs.readFile(configPath, "utf8");
    // SAFETY: JSON.parse returns any; we cast to Partial<LocalWorkspaceConfig>
    // and then validate each field is present (non-undefined) before using
    // the value as a full LocalWorkspaceConfig.
    const parsed = JSON.parse(raw) as Partial<LocalWorkspaceConfig>;
    if (
      parsed.workspaceId === undefined ||
      parsed.rootPath === undefined ||
      parsed.name === undefined ||
      parsed.updatedAt === undefined
    ) {
      return null;
    }
    // SAFETY: all four required fields are checked non-undefined above, so
    // the Partial<LocalWorkspaceConfig> satisfies the full contract.
    return parsed as LocalWorkspaceConfig;
  } catch (error) {
    // SAFETY: fs.readFile rejects with a NodeJS.ErrnoException for ENOENT;
    // the cast narrows the unknown error to access the `code` property.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function findLocalWorkspaceConfig(
  startPath: string,
): Promise<LocalWorkspaceConfig | null> {
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
