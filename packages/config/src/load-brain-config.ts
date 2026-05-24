import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

import type { BrainConfig, BrainWorkspaceConfig } from "./types";
import { getDefaultSettings } from "./types";

const CONFIG_FILE_CANDIDATES = ["brain.config.mjs", "brain.config.js", "brain.config.ts"];

function findConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    for (const fileName of CONFIG_FILE_CANDIDATES) {
      const candidate = path.join(current, fileName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveWorkspace(configFile: string, workspace: BrainWorkspaceConfig): BrainWorkspaceConfig {
  const configDir = path.dirname(configFile);
  return {
    ...workspace,
    root: path.resolve(configDir, workspace.root)
  };
}

export async function loadBrainConfig(startDir = process.cwd()): Promise<BrainConfig> {
  const configFile = findConfigFile(startDir);

  if (!configFile) {
    const defaults = getDefaultSettings();
    return {
      chunking: defaults.chunking,
      retrieval: defaults.retrieval
    };
  }

  const source = await fs.readFile(configFile, "utf8");
  const sanitized = source
    .replace(/^import\s+type\s+.*$/gm, "")
    .replace(/^import\s+.*$/gm, "")
    .replace(/const\s+config\s*:\s*[^=]+=/m, "const config =")
    .replace(/export default\s+/m, "const __default__ = ");

  const evaluator = new Function(
    `${sanitized}\nreturn typeof __default__ !== "undefined" ? __default__ : (typeof config !== "undefined" ? config : undefined);`
  );
  const loaded = evaluator() as BrainConfig | undefined;

  const defaults = getDefaultSettings();

  if (!loaded) {
    return {
      chunking: defaults.chunking,
      retrieval: defaults.retrieval
    };
  }

  return {
    workspaces: loaded.workspaces?.map((workspace) => resolveWorkspace(configFile, workspace)),
    chunking: loaded.chunking ?? defaults.chunking,
    retrieval: loaded.retrieval ?? defaults.retrieval
  };
}

export async function getWorkspaceConfig(workspaceId: string, startDir = process.cwd()): Promise<BrainWorkspaceConfig> {
  const config = await loadBrainConfig(startDir);
  const workspace = config.workspaces?.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' was not found in brain.config.ts`);
  }
  return workspace;
}

export async function getBrainSettings(startDir = process.cwd()): Promise<{
  chunking: { targetTokens: number; overlapTokens: number };
  retrieval: {
    vectorLimit: number;
    textLimit: number;
    graphHops: number;
    maxGraphNeighbors: number;
    finalLimit: number;
    maxContextTokens: number;
  };
}> {
  const config = await loadBrainConfig(startDir);
  const defaults = getDefaultSettings();
  return {
    chunking: config.chunking ?? defaults.chunking,
    retrieval: config.retrieval ?? defaults.retrieval
  };
}
