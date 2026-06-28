import { useEffect, useDeferredValue, useState } from "react";
import type { Highlighter } from "shiki";
import { useTheme } from "../lib/theme";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Lazily create the singleton highlighter with the bundled languages and
    // themes needed for the chunk viewer. The promise is cached at module
    // scope so all ChunkContent instances share one highlighter.
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
          "typescript",
          "javascript",
          "python",
          "go",
          "rust",
          "markdown",
          "yaml",
          "json",
          "toml",
          "bash",
          "css",
          "html",
        ],
      }),
    );
  }
  return highlighterPromise;
}

const SUPPORTED_LANGS = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "markdown",
  "yaml",
  "json",
  "toml",
  "bash",
  "css",
  "html",
]);

function resolveShikiLang(language: string | null | undefined, kind: string, content: string): string {
  if (language && SUPPORTED_LANGS.has(language.toLowerCase())) {
    return language.toLowerCase();
  }
  if (kind === "markdown") return "markdown";
  if (kind === "config") {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
    if (/^\[[^\]]+\]\s*$/m.test(trimmed) && /=/.test(trimmed)) return "toml";
    if (/^[^\s#].*:\s/m.test(trimmed)) return "yaml";
    return "json";
  }
  if (language) {
    const lower = language.toLowerCase();
    if (lower === "ts" || lower === "tsx") return "typescript";
    if (lower === "js" || lower === "jsx") return "javascript";
    if (lower === "py") return "python";
    if (lower === "rs") return "rust";
    if (lower === "sh" || lower === "shell") return "bash";
    if (lower === "yml") return "yaml";
  }
  return "text";
}

interface ChunkContentProps {
  content: string;
  language: string | null;
  kind: string;
}

export function ChunkContent({ content, language, kind }: ChunkContentProps) {
  const deferredContent = useDeferredValue(content);
  const shikiLang = resolveShikiLang(language, kind, deferredContent);
  const [html, setHtml] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const shikiTheme = resolvedTheme === "light" ? "github-light" : "github-dark";

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    getHighlighter()
      .then((highlighter) =>
        highlighter.codeToHtml(deferredContent, {
          lang: shikiLang,
          theme: shikiTheme,
        }),
      )
      .then((highlighted) => {
        if (!cancelled) setHtml(highlighted);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deferredContent, shikiLang, shikiTheme]);

  if (html) {
    return (
      <div
        className="text-sm overflow-x-auto rounded-md"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="text-sm overflow-x-auto rounded-md bg-muted/30 p-3">
      <code>{deferredContent}</code>
    </pre>
  );
}
