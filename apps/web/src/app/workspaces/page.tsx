import Link from "next/link";
import {
  listWorkspaces
} from "./actions";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@openez-graph/ui";
import {
  Plus,
  FolderOpen,
  Search,
  Layers,
  AlertTriangle
} from "lucide-react";

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline",
    indexing: "secondary",
    indexed: "default",
    error: "destructive",
    running: "secondary",
    completed: "default",
    failed: "destructive"
  };

  return (
    <Badge variant={variants[status] ?? "outline"}>
      {status}
    </Badge>
  );
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default async function WorkspacesPage() {
  const result = await listWorkspaces();

  if (!result.ok) {
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
              Could not open the registry database. The OpenEZ Graph
              workspace registry stores workspace metadata and must be
              accessible for this page to function.
            </p>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-1">
              Configured path: <code className="text-xs">{result.dbPath}</code>
            </p>
            <p className="text-sm text-destructive text-center max-w-md">
              {result.error}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const allWorkspaces = result.data;

  return (
    <div className="page">
      <div className="flex items-center justify-between">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">Manage indexed codebases and projects.</p>
        </div>
        <Link href="/workspaces/new">
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
              Workspaces track documents, chunks, and graph relationships.
            </p>
            <Link href="/workspaces/new">
              <Button>
                <Plus className="h-4 w-4" />
                Create Workspace
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {allWorkspaces.map((workspace) => (
            <Link
              key={workspace.id}
              href={`/workspaces/${workspace.id}`}
              className="block"
            >
              <Card className="hover:bg-muted/50 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h2 className="text-lg font-medium truncate">
                          {workspace.name}
                        </h2>
                        <StatusBadge status={workspace.status} />
                      </div>
                      <p className="muted text-sm truncate mb-3">
                        {workspace.rootPath}
                      </p>

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
                        {workspace.nodeCount != null && workspace.nodeCount > 0 && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">
                              {workspace.nodeCount} nodes
                            </span>
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
      )}
    </div>
  );
}