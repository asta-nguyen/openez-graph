import { useEffect, useMemo, useState } from "react";
import { ChunkContent } from "./chunk-content";

interface StructuredContentViewerProps {
  content: string;
  kind: string;
  language: string | null;
}

type ViewMode = "tree" | "text";

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isJsonContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function JsonValue({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }
  if (typeof value === "string") {
    return <span className="text-green-600 dark:text-green-400">"{value}"</span>;
  }
  return <span>{String(value)}</span>;
}

function JsonTree({ data, name }: { data: unknown; name?: string }) {
  if (data === null || typeof data !== "object") {
    return (
      <div className="font-mono text-sm">
        {name !== undefined && (
          <span className="text-muted-foreground">{name}: </span>
        )}
        <JsonValue value={data} />
      </div>
    );
  }

  const isArray = Array.isArray(data);
  const entries = isArray
    ? (data as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(data as Record<string, unknown>);

  return (
    <details open className="font-mono text-sm">
      <summary className="cursor-pointer select-none hover:bg-muted/50 rounded px-1">
        {name !== undefined && (
          <span className="text-muted-foreground">{name}: </span>
        )}
        <span className="text-muted-foreground">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </summary>
      <div className="ml-4 border-l border-border pl-2">
        {entries.map(([key, val]) => (
          <JsonTree key={key} data={val} name={isArray ? undefined : key} />
        ))}
      </div>
    </details>
  );
}

export function StructuredContentViewer({
  content,
  kind,
  language,
}: StructuredContentViewerProps) {
  const parsed = useMemo(() => tryParseJson(content), [content]);
  const isJson = parsed !== null && isJsonContent(content);

  const [view, setView] = useState<ViewMode>(isJson ? "tree" : "text");

  // Re-evaluate the default view when content changes (plan 05-06).
  useEffect(() => {
    setView(isJson ? "tree" : "text");
  }, [isJson]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!isJson}
          onClick={() => setView("tree")}
          className={`px-2 py-1 text-xs rounded-md border transition-colors ${
            view === "tree"
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted"
          } ${!isJson ? "opacity-50 cursor-not-allowed" : ""}`}
          title={isJson ? "Tree view" : "Tree view available for JSON only"}
        >
          Tree
        </button>
        <button
          type="button"
          onClick={() => setView("text")}
          className={`px-2 py-1 text-xs rounded-md border transition-colors ${
            view === "text"
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted"
          }`}
        >
          Text
        </button>
      </div>

      {view === "tree" && isJson && parsed !== null ? (
        <div
          key={content}
          className="max-h-96 overflow-y-auto rounded-md bg-muted/20 p-3"
        >
          <JsonTree data={parsed} />
        </div>
      ) : (
        <ChunkContent content={content} language={language} kind={kind} />
      )}
    </div>
  );
}
