interface BoundaryChunk {
  chunkIndex: number;
  metadata: {
    startLine?: number;
    endLine?: number;
  };
}

interface ChunkBoundaryBarProps {
  chunks: BoundaryChunk[];
}

/**
 * Renders a horizontal bar showing each chunk as a colored segment
 * proportional to its line span. Overlap regions (where a chunk's startLine
 * is <= the previous chunk's endLine) are marked with an amber border.
 */
export function ChunkBoundaryBar({ chunks }: ChunkBoundaryBarProps) {
  if (chunks.length === 0) return null;

  const withLines = chunks.filter(
    (c) =>
      typeof c.metadata.startLine === "number" &&
      typeof c.metadata.endLine === "number",
  );

  if (withLines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No boundary info available.</p>
    );
  }

  const minStart = Math.min(...withLines.map((c) => c.metadata.startLine!));
  const maxEnd = Math.max(...withLines.map((c) => c.metadata.endLine!));
  const totalSpan = Math.max(1, maxEnd - minStart + 1);

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex h-6 min-w-full gap-px rounded-md overflow-hidden border">
        {chunks.map((chunk, idx) => {
          const start = chunk.metadata.startLine;
          const end = chunk.metadata.endLine;
          const hasLines = typeof start === "number" && typeof end === "number";

          // Detect overlap with the previous chunk that has line info.
          let isOverlap = false;
          if (hasLines && idx > 0) {
            const prev = chunks[idx - 1];
            if (
              typeof prev.metadata.endLine === "number" &&
              start! <= prev.metadata.endLine
            ) {
              isOverlap = true;
            }
          }

          const widthPct = hasLines
            ? `${((end! - start! + 1) / totalSpan) * 100}%`
            : `${100 / chunks.length}%`;

          const tooltip = hasLines
            ? `Chunk #${chunk.chunkIndex}: lines ${start}\u2013${end}`
            : `Chunk #${chunk.chunkIndex}: no line info`;

          return (
            <div
              key={chunk.chunkIndex}
              title={tooltip}
              className={`h-full shrink-0 ${
                idx % 2 === 0 ? "bg-primary/30" : "bg-primary/50"
              } ${isOverlap ? "border-l-2 border-amber-500" : ""}`}
              style={{ width: widthPct }}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-1 text-xs text-muted-foreground">
        <span>Line {minStart}</span>
        <span>Line {maxEnd}</span>
      </div>
    </div>
  );
}
