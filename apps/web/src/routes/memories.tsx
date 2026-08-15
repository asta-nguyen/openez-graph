import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type MemoryRow } from "../lib/api";
import { memoriesQueryOptions, memoriesSearchQueryOptions } from "../lib/queries";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Textarea,
  Label,
  Badge,
} from "@openez-graph/ui";
import { formatDate } from "../lib/utils";
import { PAGE_SIZE, Pagination } from "../lib/pagination";
import { Plus, Trash2, Search, X } from "lucide-react";

export const Route = createFileRoute("/memories")({
  loader: ({ context }) => context.queryClient.ensureQueryData(memoriesQueryOptions(1, PAGE_SIZE)),
  component: MemoriesPage,
  validateSearch: (search: Record<string, string | undefined>) => ({
    page: Math.max(1, parseInt(search.page ?? "", 10) || 1),
  }),
});

function MemoriesPage() {
  const queryClient = useQueryClient();
  const { page: currentPage } = useSearch({ from: "/memories" });
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedMemory, setSelectedMemory] = useState<MemoryRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isSearching = debouncedSearch.trim().length > 0;
  const queryOpts = isSearching
    ? memoriesSearchQueryOptions(debouncedSearch)
    : memoriesQueryOptions(currentPage, PAGE_SIZE);
  const { data, isLoading } = useQuery({
    ...queryOpts,
    placeholderData: (prev) => prev,
  });

  const totalPages = isSearching ? 1 : Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (!isSearching) {
      const next = currentPage + 1;
      if (next <= totalPages) {
        queryClient.prefetchQuery(memoriesQueryOptions(next, PAGE_SIZE));
      }
    }
  }, [currentPage, totalPages, queryClient, isSearching]);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteMemory(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setSelectedMemory(null);
    },
  });

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  return (
    <div className="page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1>Memories</h1>
          <p className="muted text-sm">
            Technical decisions and agent notes persisted across sessions.
          </p>
        </div>
        <Button onClick={() => setShowCreateForm(true)} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New Memory
        </Button>
      </div>

      <Card className="mb-4">
        <CardContent className="pt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search memories by title or content..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {isSearching ? `Search results (${items.length})` : `Memories (${totalCount})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {isSearching
                ? "No memories match your search."
                : "No memories yet. Create one to get started."}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((memory) => (
                    <TableRow
                      key={memory.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelectedMemory(memory)}
                    >
                      <TableCell className="font-medium">{memory.title}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {memory.tags.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            memory.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {memory.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(memory.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteMutation.mutate(memory.id);
                          }}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!isSearching && (
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  basePath="/memories"
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      {showCreateForm && (
        <CreateMemoryDialog
          onClose={() => setShowCreateForm(false)}
          onCreated={() => {
            setShowCreateForm(false);
            queryClient.invalidateQueries({ queryKey: ["memories"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          }}
        />
      )}

      {selectedMemory && (
        <MemoryDetailDialog
          memory={selectedMemory}
          onClose={() => setSelectedMemory(null)}
          onDelete={() => deleteMutation.mutate(selectedMemory.id)}
          deleting={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

function CreateMemoryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createMemory({
        title: title.trim(),
        content: content.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: (res) => {
      if (res.ok && res.data) {
        onCreated();
      } else {
        setError("Failed to create memory");
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      setError("Title and content are required");
      return;
    }
    createMutation.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>New Memory</CardTitle>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="memory-title">Title</Label>
              <Input
                id="memory-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Use SQLite WAL mode for all workspaces"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="memory-content">Content</Label>
              <Textarea
                id="memory-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Describe the technical decision or note..."
                rows={6}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="memory-tags">Tags (comma-separated)</Label>
              <Input
                id="memory-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. architecture, storage, decision"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function MemoryDetailDialog({
  memory,
  onClose,
  onDelete,
  deleting,
}: {
  memory: MemoryRow;
  onClose: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{memory.title}</CardTitle>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex gap-2 flex-wrap">
              {memory.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
              <Badge variant="outline" className="text-xs">
                {memory.source}
              </Badge>
            </div>
            <div className="text-sm whitespace-pre-wrap">{memory.content}</div>
            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-xs text-muted-foreground">
                <div>Created: {formatDate(memory.createdAt)}</div>
                <div>Updated: {formatDate(memory.updatedAt)}</div>
              </div>
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
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
