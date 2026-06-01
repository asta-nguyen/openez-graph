import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Input, Label, Textarea,
} from "@openez-graph/ui";
import { api } from "../../lib/api";
import {
  ChevronLeft, FolderOpen, Loader2, CheckCircle2, XCircle, Globe, FileCode2,
} from "lucide-react";

export const Route = createFileRoute("/workspaces/new")({
  component: NewWorkspacePage,
});

const DEFAULT_INCLUDE_GLOBS = `src/**/*.{ts,tsx,js,jsx}
app/**/*.{ts,tsx}
pages/**/*.{ts,tsx}
lib/**/*.{ts,tsx}
**/*.md`;

const DEFAULT_EXCLUDE_GLOBS = `node_modules/**
**/node_modules/**
.next/**
dist/**
build/**
.git/**
coverage/**
**/.turbo/**`;

function NewWorkspacePage() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathValid, setPathValid] = useState<boolean | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  async function handleValidatePath(rootPath: string) {
    if (!rootPath.trim()) {
      setPathValid(null);
      setPathError(null);
      return;
    }
    try {
      const result = await api.validatePath(rootPath);
      setPathValid(result.valid);
      setPathError(result.valid ? null : result.error ?? "Invalid path");
    } catch {
      setPathValid(false);
      setPathError("Validation failed");
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const formData = new FormData(e.currentTarget);
      const result = await api.createWorkspace({
        name: formData.get("name") as string,
        rootPath: formData.get("rootPath") as string,
        includeGlobs: (formData.get("includeGlobs") as string || DEFAULT_INCLUDE_GLOBS)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        excludeGlobs: (formData.get("excludeGlobs") as string || DEFAULT_EXCLUDE_GLOBS)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });

      if (result.success && result.workspace) {
        navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: result.workspace.id } });
      } else {
        setError(result.error ?? "Failed to create workspace");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page">
      <div className="flex items-start gap-4 mb-6">
        <Link to="/workspaces" search={{ page: 1 }}>
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0">
          <h1>New Workspace</h1>
          <p className="muted">Register a local codebase for indexing.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Workspace Configuration</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-8">
            {error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">{error}</div>
            )}

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label htmlFor="name" className="mb-2 block">
                  <span className="flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5" />
                    Workspace Name
                  </span>
                </Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="my-project"
                  required
                  pattern="[a-zA-Z0-9_-]+"
                  title="Letters, numbers, hyphens, and underscores only"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Used as the workspace ID. Letters, numbers, hyphens, and underscores.
                </p>
              </div>

              <div>
                <Label htmlFor="rootPath" className="mb-2 block">
                  <span className="flex items-center gap-1.5">
                    <FolderOpen className="h-3.5 w-3.5" />
                    Root Path
                  </span>
                </Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="rootPath"
                      name="rootPath"
                      placeholder="/path/to/project"
                      required
                      onBlur={(e) => handleValidatePath(e.target.value)}
                      className="pr-10"
                    />
                    {pathValid === true && (
                      <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary" />
                    )}
                    {pathValid === false && (
                      <XCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-destructive" />
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => {
                      const input = document.getElementById("rootPath") as HTMLInputElement;
                      if (input?.value) handleValidatePath(input.value);
                    }}
                  >
                    Validate
                  </Button>
                </div>
                {pathError && <p className="mt-2 text-xs text-destructive">{pathError}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  Absolute path to the project root directory.
                </p>
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Label htmlFor="includeGlobs" className="mb-2 block">
                  <span className="flex items-center gap-1.5">
                    <FileCode2 className="h-3.5 w-3.5" />
                    Include Patterns
                  </span>
                </Label>
                <Textarea
                  id="includeGlobs"
                  name="includeGlobs"
                  defaultValue={DEFAULT_INCLUDE_GLOBS}
                  rows={6}
                  className="font-mono text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Glob patterns for files to index. One per line.
                </p>
              </div>

              <div>
                <Label htmlFor="excludeGlobs" className="mb-2 block">
                  <span className="flex items-center gap-1.5">
                    <XCircle className="h-3.5 w-3.5" />
                    Exclude Patterns
                  </span>
                  <Badge variant="outline" className="ml-2 text-xs px-1 py-0">optional</Badge>
                </Label>
                <Textarea
                  id="excludeGlobs"
                  name="excludeGlobs"
                  defaultValue={DEFAULT_EXCLUDE_GLOBS}
                  rows={6}
                  className="font-mono text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Glob patterns for files to exclude. One per line.
                </p>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
              <Link to="/workspaces" search={{ page: 1 }} className="sm:order-1">
                <Button type="button" variant="secondary" className="w-full sm:w-auto">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" disabled={pending} className="w-full sm:w-auto">
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Workspace
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
