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

// Dither patterns using CSS gradients — alternating pixels create a
// textured fill that's visually distinct from flat color blocks.
const DITHER_STYLES = [
  // Style 0: blue dither
  {
    backgroundColor: "#1e3a5f",
    backgroundImage:
      "repeating-conic-gradient(#3b82f6 0% 25%, #1e3a5f 0% 50%)",
    backgroundSize: "4px 4px",
  },
  // Style 1: teal dither
  {
    backgroundColor: "#134e4a",
    backgroundImage:
      "repeating-conic-gradient(#14b8a6 0% 25%, #134e4a 0% 50%)",
    backgroundSize: "4px 4px",
  },
  // Style 2: violet dither
  {
    backgroundColor: "#2e1065",
    backgroundImage:
      "repeating-conic-gradient(#8b5cf6 0% 25%, #2e1065 0% 50%)",
    backgroundSize: "4px 4px",
  },
  // Style 3: amber dither
  {
    backgroundColor: "#422006",
    backgroundImage:
      "repeating-conic-gradient(#f59e0b 0% 25%, #422006 0% 50%)",
    backgroundSize: "4px 4px",
  },
];

/**
 * Renders a horizontal bar showing each chunk as a dithered segment
 * proportional to its line span. Overlap regions get a red left border.
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

  // If any chunks lack line info, fall back to equal width for ALL chunks so
  // the bar stays visually consistent instead of mixing proportional and
  // flat widths.
  const hasMissingLineInfo = withLines.length !== chunks.length;
  const equalWidthPct = `${100 / chunks.length}%`;

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex h-6 min-w-full gap-px rounded-md overflow-hidden border border-border">
        {chunks.map((chunk, idx) => {
          const start = chunk.metadata.startLine;
          const end = chunk.metadata.endLine;
          const hasLines = typeof start === "number" && typeof end === "number";

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

          const widthPct =
            hasLines && !hasMissingLineInfo
              ? `${((end! - start! + 1) / totalSpan) * 100}%`
              : equalWidthPct;

          const tooltip = hasLines
            ? `Chunk #${chunk.chunkIndex}: lines ${start}\u2013${end}`
            : `Chunk #${chunk.chunkIndex}: no line info`;

          const dither = DITHER_STYLES[chunk.chunkIndex % DITHER_STYLES.length];

          return (
            <div
              key={chunk.chunkIndex}
              title={tooltip}
              className="h-full shrink-0 transition-opacity hover:opacity-80"
              style={{
                width: widthPct,
                ...dither,
                borderLeft: isOverlap ? "2px solid #ef4444" : undefined,
              }}
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
