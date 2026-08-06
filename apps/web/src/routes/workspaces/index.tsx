import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { api, type WorkspaceListItem } from "../../lib/api";
import { formatDate } from "../../lib/utils";
import { workspacesQueryOptions, workspaceQueryOptions } from "../../lib/queries";
import { PAGE_SIZE, Pagination, paginate } from "../../lib/pagination";
import { StatusBadge } from "../../components/status-badge";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";
import { Plus, FolderOpen, Search, Layers, AlertTriangle, Pin, Trash2 } from "lucide-react";

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
  const { data: result, isLoading, error } = useQuery(workspacesQueryOptions);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<WorkspaceListItem | null>(null);

  const pinMutation = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await api.pinWorkspace(id, pinned);
      if (!res.success) {
        throw new Error(res.error ?? "Failed to update pin");
      }
      return res;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.deleteWorkspace(id);
      if (!res.success) {
        throw new Error(res.error ?? "Failed to delete workspace");
      }
      return res;
    },
    onSuccess: () => {
      setWorkspaceToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (isLoading)
    return (
      <div className="page">
        <p className="muted">Loading...</p>
      </div>
    );

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
            <p className="muted text-center mb-4 max-w-md">Could not open the registry database.</p>
            {err && "error" in err && (
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
        <Link to="/workspaces/new">
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
            <Link to="/workspaces/new">
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
                            <span className="text-muted-foreground">
                              {workspace.documentCount ?? 0} docs
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Search className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              {workspace.chunkCount ?? 0} chunks
                            </span>
                          </div>
                          {(workspace.nodeCount ?? 0) > 0 && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-muted-foreground">
                                {workspace.nodeCount} nodes
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <div className="flex items-center justify-end gap-1 mb-1">
                          <button
                            title={workspace.pinnedAt ? "Unpin workspace" : "Pin workspace"}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              pinMutation.mutate({ id: workspace.id, pinned: !workspace.pinnedAt });
                            }}
                            disabled={
                              pinMutation.isPending && pinMutation.variables?.id === workspace.id
                            }
                            className={
                              workspace.pinnedAt
                                ? "text-primary"
                                : "text-muted-foreground hover:text-foreground transition-colors"
                            }
                          >
                            <Pin
                              className={`h-4 w-4 ${workspace.pinnedAt ? "fill-current" : ""}`}
                            />
                          </button>
                          <button
                            title="Delete workspace"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setWorkspaceToDelete(workspace);
                            }}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex gap-2 mb-1">
                          <StatusBadge status={workspace.indexingStatus} />
                          <StatusBadge status={workspace.graphStatus} />
                        </div>
                        <p className="muted text-xs">
                          Last indexed: {formatDate(workspace.lastIndexedAt)}
                        </p>
                      </div>
                    </div>
                    {pinMutation.isError && pinMutation.variables?.id === workspace.id && (
                      <p className="text-sm text-destructive mt-2">
                        {pinMutation.error instanceof Error
                          ? pinMutation.error.message
                          : "Failed to update pin"}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <Pagination currentPage={safePage} totalPages={totalPages} basePath="/workspaces/" />
        </>
      )}

      {workspaceToDelete && (
        <DeleteWorkspaceDialog
          workspace={workspaceToDelete}
          onClose={() => setWorkspaceToDelete(null)}
          onConfirm={() => deleteMutation.mutate(workspaceToDelete.id)}
          deleting={deleteMutation.isPending}
          error={
            deleteMutation.isError
              ? deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : "Failed to delete workspace"
              : null
          }
        />
      )}
    </div>
  );
}

function DeleteWorkspaceDialog({
  workspace,
  onClose,
  onConfirm,
  deleting,
  error,
}: {
  workspace: WorkspaceListItem;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
  error: string | null;
}) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Restore focus to the trigger when the dialog closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  // Close on Escape and trap focus within the dialog.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", handleKeyDown);
    return () => node.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle id={titleId}>Delete workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              Delete <span className="font-medium">{workspace.name}</span>? The registry entry and{" "}
              <code className="text-xs">{workspace.rootPath}/.openez</code> will be permanently
              deleted. Project source code is not touched.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                ref={cancelRef}
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={onConfirm} disabled={deleting}>
                <Trash2 className="h-4 w-4 mr-1" />
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
