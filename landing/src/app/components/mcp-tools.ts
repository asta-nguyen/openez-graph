import { Brain, FolderGit2, Search } from "lucide-react";
import { mcpReferenceGroups } from "./mcp-reference";

const icons = { Retrieval: Search, Memory: Brain, Workspaces: FolderGit2 };

export const mcpToolGroups = mcpReferenceGroups.map((group) => ({
  ...group,
  icon: icons[group.label],
}));

export const mcpToolCount = mcpToolGroups.reduce((n, g) => n + g.tools.length, 0);
