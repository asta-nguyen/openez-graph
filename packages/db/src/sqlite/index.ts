export {
  getRegistryDb,
  closeRegistryDb,
  resolveRegistryDbPath,
  getRegistryDdl,
  migrateRegistrySchema,
} from "./registry-db";
export type { SqliteLike } from "./registry-db";
export { getWorkspaceDb, closeAllWorkspaceDbs, getFullWorkspaceDdl } from "./workspace-db";
export { createRegistryRepository, createWorkspaceRepository } from "./repository";
export { encryptValue, decryptValue, isEncrypted, isSensitiveKey } from "./secure-storage";
export {
  findLocalWorkspaceConfig,
  getLocalWorkspaceConfigPath,
  getLocalWorkspaceDir,
  readLocalWorkspaceConfig,
  writeLocalWorkspaceConfig,
} from "./local-workspace";
export { removeWorkspace } from "./remove-workspace";
export type { RemoveWorkspaceReport, RemoveWorkspaceSelector } from "./remove-workspace";
export type {
  RegistryWorkspace,
  RegistryRepository,
  StoredMemory,
  WorkspaceQueryLog,
  WorkspaceQueryMetrics,
  WorkspaceRepository,
  WorkspaceSettings,
} from "./types";
export type { LocalWorkspaceConfig } from "./local-workspace";
export * as schema from "./schema";
