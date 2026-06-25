"use client";

import { useEffect, useState } from "react";

interface GitHubStarsProps {
  repo: string;
  initialCount?: number | null;
}

export function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function GitHubStars({ repo, initialCount = null }: GitHubStarsProps) {
  const [stars, setStars] = useState<number | null>(initialCount);

  useEffect(() => {
    if (initialCount !== null && initialCount !== undefined) return;

    let cancelled = false;
    fetch(`https://api.github.com/repos/${repo}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && typeof data.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {
        if (!cancelled) setStars(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, initialCount]);

  const display = stars !== null ? formatStars(stars) : null;

  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/30 transition-all duration-200 group/gh"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="transition-all duration-200 group-hover/gh:scale-110"
      >
        <path
          d="M8 1l1.55 5.02h5.02l-4.07 2.95 1.56 5.02L8 11.04l-4.06 2.95 1.56-5.02L1.43 6.02h5.02L8 1z"
          fill="currentColor"
          opacity="0.5"
          className="group-hover/gh:opacity-80"
        />
      </svg>
      <span>GitHub</span>
      {display !== null && (
        <span className="tabular-nums text-primary/70 text-[11px] font-mono">
          {display}
        </span>
      )}
    </a>
  );
}
