import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { formatDate } from "../../lib/utils";
import { workspacesQueryOptions, workspaceQueryOptions } from "../../lib/queries";
import { PAGE_SIZE, Pagination, paginate } from "../../lib/pagination";
import { StatusBadge } from "../../components/status-badge";
import {
  Button, Card, CardContent, CardHeader, CardTitle,
} from "@openez-graph/ui";
import { Plus, FolderOpen, Search, Layers, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/workspaces/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(workspacesQueryOptions),
  component: WorkspacesPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
});

function WorkspacesPage() {
  const queryClient = useQueryClient();
  const { page: currentPage } = useSearch({ from: "/workspaces/" });
  const { workspaceId } = useSearch({ from: "__root__" });
  const { data: result, isLoading, error } = useQuery(workspacesQueryOptions);

  if (isLoading) return <div className="page"><p className="muted">Loading...</p></div>;

  if (error || (result && !result.ok)) {
    const err = result && !result.ok ? result : null;
    return (
      <div className="page">
        <div className="flex items-center justify-between">
          <div>
            <h1>Workspaces</h1>
            <p className="muted">Manage indexed codebases and projects.</p>
          </div>
        </div>
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
            <h2 className="text-lg font-medium mb-2">Registry unavailable</h2>
            <p className="muted text-center mb-4 max-w-md">
              Could not open the registry database.
            </p>
            {err && 'error' in err && (
              <p className="text-sm text-destructive text-center max-w-md">
                {(err as { error: string }).error}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const allWorkspaces = result?.data ?? [];
  const totalPages = Math.max(1, Math.ceil(allWorkspaces.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const { paged } = paginate(allWorkspaces, safePage);

  return (
    <div className="page">
      <div className="flex items-center justify-between">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">Manage indexed codebases and projects.</p>
        </div>
        <Link to="/workspaces/new" search={{ workspaceId }}>
          <Button>
            <Plus className="h-4 w-4" />
            New Workspace
          </Button>
        </Link>
      </div>

      {allWorkspaces.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-medium mb-2">No workspaces yet</h2>
            <p className="muted text-center mb-6 max-w-sm">
              Create your first workspace to start indexing a codebase.
            </p>
            <Link to="/workspaces/new" search={{ workspaceId }}>
              <Button>
                <Plus className="h-4 w-4" />
                Create Workspace
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Showing {paged.length} of {allWorkspaces.length} workspaces
          </p>
          <div className="space-y-4">
            {paged.map((workspace) => (
              <Link
                key={workspace.id}
                to="/workspaces/$workspaceId"
                params={{ workspaceId: workspace.id }}
                search={{ workspaceId }}
                className="block"
                onMouseEnter={() => queryClient.prefetchQuery(workspaceQueryOptions(workspace.id))}
              >
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h2 className="text-lg font-medium truncate">{workspace.name}</h2>
                          <StatusBadge status={workspace.status} />
                        </div>
                        <p className="muted text-sm truncate mb-3">{workspace.rootPath}</p>
                        <div className="flex flex-wrap gap-4 text-sm">
                          <div className="flex items-center gap-1.5">
                            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">{workspace.documentCount ?? 0} docs</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Search className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">{workspace.chunkCount ?? 0} chunks</span>
                          </div>
                          {(workspace.nodeCount ?? 0) > 0 && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-muted-foreground">{workspace.nodeCount} nodes</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="flex gap-2 mb-1">
                          <StatusBadge status={workspace.indexingStatus} />
                          <StatusBadge status={workspace.graphStatus} />
                        </div>
                        <p className="muted text-xs">
                          Last indexed: {formatDate(workspace.lastIndexedAt)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <Pagination currentPage={safePage} totalPages={totalPages} basePath="/workspaces/" />
        </>
      )}
    </div>
  );
}
