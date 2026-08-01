import { Highlight, themes } from "prism-react-renderer";
import { Badge } from "@openez-graph/ui";
import { FileText } from "lucide-react";

interface ContextBlock {
  path: string;
  startLine: string;
  endLine: string;
  score: string;
  code: string;
}

function parseContextBlocks(raw: string): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  const regex = /\[source:\s*(.+?):(\d+|\?)-(\d+|\?)\s*\|\s*score:\s*([\d.]+)\]\n([\s\S]*?)(?=\n\[source:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    blocks.push({
      path: match[1],
      startLine: match[2],
      endLine: match[3],
      score: match[4],
      code: match[5].trimEnd(),
    });
  }
  return blocks;
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
  };
  return map[ext] ?? "text";
}

export function ContextBlocks({ raw }: { raw: string }) {
  const blocks = parseContextBlocks(raw);

  if (blocks.length === 0) {
    return (
      <pre className="text-sm whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-4 overflow-x-auto">
        {raw}
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => {
        const language = inferLanguage(block.path);
        return (
          <div key={i} className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/50 border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-mono text-xs truncate">{block.path}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  :{block.startLine}-{block.endLine}
                </span>
              </div>
              <Badge variant="outline" className="text-xs shrink-0">
                {block.score}
              </Badge>
            </div>
            <Highlight theme={themes.nightOwl} code={block.code} language={language}>
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre
                  className={`${className} text-xs overflow-x-auto p-3 m-0`}
                  style={{ ...style, background: "transparent" }}
                >
                  {tokens.map((line, j) => {
                    const lineProps = getLineProps({ line, key: j });
                    return (
                      <div key={j} {...lineProps} className={`${lineProps.className} table-row`}>
                        <span className="table-cell pr-3 text-right select-none opacity-30 text-xs">
                          {j + 1}
                        </span>
                        <span className="table-cell">
                          {line.map((token, k) => (
                            <span key={k} {...getTokenProps({ token, key: k })} />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </pre>
              )}
            </Highlight>
          </div>
        );
      })}
    </div>
  );
}
