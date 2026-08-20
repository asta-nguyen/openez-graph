import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

export async function memoryWrite(input: {
  workspaceId: string;
  title: string;
  content: string;
  tags?: string[];
  supersedesId?: number | string;
  source?: "user" | "agent" | "system";
}) {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const repo = createWorkspaceRepository(workspace.rootPath);
  const numericSupersedesId =
    input.supersedesId !== undefined && input.supersedesId !== null
      ? Number(input.supersedesId)
      : undefined;
  if (
    numericSupersedesId !== undefined &&
    (!Number.isFinite(numericSupersedesId) || !(await repo.getMemory(numericSupersedesId)))
  ) {
    throw new Error(`Memory '${input.supersedesId}' not found`);
  }
  const id = await repo.insertMemory({
    title: input.title,
    content: input.content,
    tags: (input.tags ?? []).join(","),
    source: input.source ?? "agent",
    supersedesId: numericSupersedesId,
  });

  return { id, ...input };
}

export async function memoryRecall(input: { workspaceId: string; query: string; limit?: number }) {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const repo = createWorkspaceRepository(workspace.rootPath);
  const memories = await repo.searchMemories(input.query, input.limit ?? 10);
  return {
    memories: memories.map((memory) => ({
      ...memory,
      tags: memory.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    })),
  };
}
