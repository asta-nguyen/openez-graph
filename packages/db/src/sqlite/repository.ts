// repository.ts — thin re-export facade for backward compatibility.
//
// The concrete implementations have been split into focused modules:
//   - registry-repository.ts   → createRegistryRepository
//   - workspace-repository.ts  → createWorkspaceRepository
//   - fts-repository.ts        → restoreFtsTriggerDefinitions
//
// Existing callers that import from "./repository" continue to work unchanged.

export { createRegistryRepository } from "./registry-repository";
export { createWorkspaceRepository } from "./workspace-repository";
export { restoreFtsTriggerDefinitions } from "./fts-repository";
export type { NativeDatabase } from "./shared-types";
