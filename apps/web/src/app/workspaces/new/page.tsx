"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea
} from "@openez-graph/ui";
import { createWorkspace, validateWorkspacePath } from "../actions";
import { ChevronLeft, Loader2, CheckCircle2, XCircle } from "lucide-react";

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

export default function NewWorkspacePage() {
  const router = useRouter();
  const [pathValid, setPathValid] = useState<boolean | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  async function handleValidatePath(rootPath: string) {
    if (!rootPath.trim()) {
      setPathValid(null);
      setPathError(null);
      return;
    }

    const result = await validateWorkspacePath(rootPath);
    setPathValid(result.valid);
    setPathError(result.valid ? null : result.error ?? "Invalid path");
  }

  const [state, formAction, pending] = useActionState(
    async (prevState: { error?: string; success?: boolean; workspaceId?: string }, formData: FormData) => {
      const result = await createWorkspace({
        name: formData.get("name") as string,
        rootPath: formData.get("rootPath") as string,
        includeGlobs: (formData.get("includeGlobs") as string || DEFAULT_INCLUDE_GLOBS)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        excludeGlobs: (formData.get("excludeGlobs") as string || DEFAULT_EXCLUDE_GLOBS)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      });

      if (result.success && result.workspace) {
        router.push(`/workspaces/${result.workspace.id}`);
        return { success: true, workspaceId: result.workspace.id };
      }

      return { error: result.error, success: false };
    },
    { error: undefined, success: false }
  );

  return (
    <div className="page">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/workspaces">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1>New Workspace</h1>
          <p className="muted">Register a local codebase for indexing.</p>
        </div>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Workspace Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-6">
            {state.error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
                {state.error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Workspace Name</Label>
              <Input
                id="name"
                name="name"
                placeholder="my-project"
                required
                pattern="[a-zA-Z0-9_-]+"
                title="Letters, numbers, hyphens, and underscores only"
              />
              <p className="text-xs text-muted-foreground">
                Used as the workspace ID. Letters, numbers, hyphens, and underscores.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rootPath">Root Path</Label>
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
                    <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
                  )}
                  {pathValid === false && (
                    <XCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-destructive" />
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const input = document.getElementById("rootPath") as HTMLInputElement;
                    if (input?.value) handleValidatePath(input.value);
                  }}
                >
                  Validate
                </Button>
              </div>
              {pathError && (
                <p className="text-xs text-destructive">{pathError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Absolute path to the project root directory.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="includeGlobs">Include Patterns</Label>
              <Textarea
                id="includeGlobs"
                name="includeGlobs"
                defaultValue={DEFAULT_INCLUDE_GLOBS}
                rows={6}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Glob patterns for files to index. One per line.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="excludeGlobs">Exclude Patterns</Label>
              <Textarea
                id="excludeGlobs"
                name="excludeGlobs"
                defaultValue={DEFAULT_EXCLUDE_GLOBS}
                rows={6}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Glob patterns for files to exclude. One per line.
              </p>
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Workspace
              </Button>
              <Link href="/workspaces">
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}