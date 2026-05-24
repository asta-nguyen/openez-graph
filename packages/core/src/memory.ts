import { createRegistryRepository, createWorkspaceRepository } from "@openez-graph/db";

export async function memoryWrite(input: {
  workspaceId: string;
  title: string;
  content: string;
  tags?: string[];
  supersedesId?: string;
  source?: "user" | "agent" | "system";
}) {
  const registry = createRegistryRepository();
  const workspace = await registry.getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace '${input.workspaceId}' not found`);
  }

  const repo = createWorkspaceRepository(workspace.rootPath);
  const id = await repo.insertMemory({
    title: input.title,
    content: input.content,
    tags: (input.tags ?? []).join(","),
    source: input.source ?? "agent",
    supersedesId: input.supersedesId
  });

  return { id, ...input };
}
