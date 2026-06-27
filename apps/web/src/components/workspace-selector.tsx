import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openez-graph/ui";
import { workspacesQueryOptions } from "../lib/queries";

export function WorkspaceSelector() {
  const { data, isLoading } = useQuery(workspacesQueryOptions);
  const { workspaceId } = useSearch({ from: "__root__" });
  // `useNavigate()` without an explicit `to` target yields a search reducer
  // whose return type resolves to `never` (the target route cannot be inferred
  // statically). Cast to a minimal signature so the URL search-param update
  // stays type-safe while keeping the navigate call site idiomatic.
  const navigate = useNavigate() as (opts: {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
  }) => Promise<void>;
  const router = useRouter();

  const workspaces = data?.data ?? [];

  const handleValueChange = (nextId: string) => {
    navigate({
      search: (prev) => ({ ...prev, workspaceId: nextId }),
    });
    router.invalidate();
  };

  if (isLoading) {
    return (
      <Select disabled value="">
        <SelectTrigger className="w-[240px]" aria-label="Workspace">
          <SelectValue placeholder="Loading workspaces..." />
        </SelectTrigger>
        <SelectContent />
      </Select>
    );
  }

  if (workspaces.length === 0) {
    return (
      <Select disabled value="">
        <SelectTrigger className="w-[240px]" aria-label="Workspace">
          <SelectValue placeholder="No workspaces registered" />
        </SelectTrigger>
        <SelectContent />
      </Select>
    );
  }

  const current = workspaceId || workspaces[0]?.id || "";

  return (
    <Select value={current} onValueChange={handleValueChange}>
      <SelectTrigger className="w-[240px]" aria-label="Workspace">
        <SelectValue placeholder="Select a workspace" />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
