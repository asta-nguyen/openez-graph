import GithubSlugger from "github-slugger";

import { countTokens } from "@openez-graph/core";

import { hashContent } from "./hash";
import type { IndexedChunk } from "./types";

interface HeadingState {
  path: string[];
  depth: number;
}

function splitLargeChunk(content: string, targetTokens: number, overlapTokens: number): string[] {
  const paragraphs = content.split(/\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (countTokens(candidate) <= targetTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    const words = paragraph.split(/\s+/);
    let window = "";
    for (const word of words) {
      const next = window ? `${window} ${word}` : word;
      if (countTokens(next) > targetTokens) {
        chunks.push(window);
        const overlap = window.split(/\s+/).slice(-overlapTokens).join(" ");
        window = overlap ? `${overlap} ${word}`.trim() : word;
      } else {
        window = next;
      }
    }
    current = window;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

export function indexMarkdown(input: {
  content: string;
  targetTokens: number;
  overlapTokens: number;
}): { chunks: IndexedChunk[]; wikilinks: string[] } {
  const lines = input.content.split("\n");
  const headingState: HeadingState = { path: [], depth: 0 };
  const sections: Array<{ heading?: string; content: string; startLine: number; endLine: number; headingPath: string[] }> = [];
  const wikilinks = new Set<string>();
  const slugger = new GithubSlugger();

  let buffer: string[] = [];
  let sectionStartLine = 1;

  const flush = (lineNumber: number) => {
    const content = buffer.join("\n").trim();
    if (!content) {
      buffer = [];
      return;
    }

    sections.push({
      heading: headingState.path.at(-1),
      content,
      startLine: sectionStartLine,
      endLine: lineNumber,
      headingPath: [...headingState.path]
    });
    buffer = [];
  };

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush(index);
      const depth = match[1].length;
      const title = match[2];
      headingState.path = headingState.path.slice(0, depth - 1);
      headingState.path[depth - 1] = title;
      headingState.depth = depth;
      sectionStartLine = index + 1;
      slugger.slug(title);
      return;
    }

    const linkMatches = [...line.matchAll(/\[\[([^\]]+)\]\]/g)];
    linkMatches.forEach((link) => wikilinks.add(link[1]));
    buffer.push(line);
  });

  flush(lines.length);

  const chunks: IndexedChunk[] = [];
  sections.forEach((section) => {
    const split = splitLargeChunk(section.content, input.targetTokens, input.overlapTokens);
    split.forEach((content, splitIndex) => {
      chunks.push({
        heading: section.heading,
        content,
        tokenCount: countTokens(content),
        contentHash: hashContent(content),
        metadata: {
          kind: "markdown",
          headingPath: section.headingPath,
          startLine: section.startLine,
          endLine: section.endLine,
          splitIndex
        }
      });
    });
  });

  return {
    chunks,
    wikilinks: [...wikilinks]
  };
}
