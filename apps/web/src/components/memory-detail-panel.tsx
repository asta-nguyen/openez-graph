import { useState } from "react";
import type { MemoryRow } from "../lib/api";
import { formatDate } from "../lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@openez-graph/ui";
import { Badge } from "@openez-graph/ui";

interface MemoryDetailPanelProps {
  memory: MemoryRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Detects whether content is structured JSON (starts with `{` or `[` and parses).
 * Returns the parsed value or null if not JSON.
 */
function tryParseJson(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function MemoryDetailPanel({ memory, open, onOpenChange }: MemoryDetailPanelProps) {
  const [viewMode, setViewMode] = useState<"tree" | "text">("tree");

  if (!memory) return null;

  const parsedJson = tryParseJson(memory.content);
  const isJson = parsedJson !== null;
  const prettyJson = isJson ? JSON.stringify(parsedJson, null, 2) : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] sm:max-w-[600px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{memory.title}</SheetTitle>
          <SheetDescription>
            Memory detail — view-only. Written via MCP memory_write.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-4">
          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{memory.source}</Badge>
            {memory.tags.map((tag) => (
              <Badge key={tag} variant="outline">{tag}</Badge>
            ))}
          </div>

          {memory.supersedesId && (
            <p className="text-sm text-muted-foreground">
              Supersedes: {memory.supersedesId}
            </p>
          )}

          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>Created: {formatDate(memory.createdAt)}</span>
            <span>Updated: {formatDate(memory.updatedAt)}</span>
          </div>

          {/* Content */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Content</h3>
              {isJson && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setViewMode("tree")}
                    className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                      viewMode === "tree"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    Tree
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("text")}
                    className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                      viewMode === "text"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    Text
                  </button>
                </div>
              )}
            </div>

            {isJson && viewMode === "tree" ? (
              <pre className="text-xs whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 overflow-x-auto">
                {prettyJson}
              </pre>
            ) : (
              <pre className="text-xs whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 overflow-x-auto">
                {memory.content}
              </pre>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
