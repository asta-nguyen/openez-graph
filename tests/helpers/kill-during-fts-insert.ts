import fs from "node:fs";

import { mock } from "bun:test";
import { createRegistryRepository } from "../../packages/db/src/sqlite/registry-repository";
import { createWorkspaceRepository } from "../../packages/db/src/sqlite/workspace-repository";
import { writeLocalWorkspaceConfig } from "../../packages/db/src/sqlite/local-workspace";
import { publicSymbolKind } from "../../packages/db/src/sqlite/utils";

const mode = process.argv[3];
const createRepository = createWorkspaceRepository;

mock.module("@openez-graph/db", () => ({
  createRegistryRepository,
  createWorkspaceRepository(rootPath: string) {
    const repo = createRepository(rootPath);
    const bulkInsertFts = repo.bulkInsertFts.bind(repo);
    repo.bulkInsertFts = async (inputs) => {
      if (mode === "throw") throw new Error("forced FTS insert failure");
      await bulkInsertFts(inputs);
      fs.writeFileSync(process.env.OPENEZ_TEST_FTS_MARKER!, "fts-inserted");
      process.kill(process.pid, "SIGKILL");
    };
    return repo;
  },
  publicSymbolKind,
  writeLocalWorkspaceConfig,
}));

const { indexWorkspace } = await import("../../packages/indexer/src/index-workspace");
try {
  await indexWorkspace({ workspaceId: process.argv[2] });
  fs.writeFileSync(process.env.OPENEZ_TEST_FTS_MARKER!, "completed");
} catch (error) {
  if (mode !== "throw") throw error;
  fs.writeFileSync(
    process.env.OPENEZ_TEST_FTS_MARKER!,
    `error:${error instanceof Error ? error.message : String(error)}`,
  );
}
