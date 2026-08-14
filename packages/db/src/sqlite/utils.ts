/**
 * Shared helpers used across the SQLite repository modules.
 *
 * `repository.ts` is being progressively split into focused modules
 * (document-repository, graph-repository, fts-repository, …). These helpers
 * avoid duplicated copies of small utility functions that more than one module
 * needs.
 */

import type { JsonValue } from "./shared-types";

/** Type guard: true when `v` is a string primitive (not a String wrapper). */
export function isString(v: JsonValue): v is string {
  return Object.prototype.toString.call(v) === "[object String]";
}

export function safeParseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    // SAFETY: JSON.parse returns any; Object(v) === v is true only for
    // non-primitive values (objects/arrays), matching the original
    // typeof === "object" && !== null guard. Non-object results fall back
    // to the caller's default, so the cast to T is justified by the
    // runtime shape check above.
    return (Object(parsed) === parsed ? parsed : fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * Sanitize a user query for FTS5 MATCH.
 * Splits into terms, strips FTS5 special characters, and joins with OR
 * so multi-word queries match any term (broader recall for code search).
 * Falls back to prefix matching for partial words.
 */
export function sanitizeFtsQuery(query: string): string {
  const stopwords = new Set([
    "a",
    "an",
    "are",
    "does",
    "extracted",
    "how",
    "implement",
    "implementation",
    "implemented",
    "in",
    "is",
    "of",
    "the",
    "to",
    "what",
    "where",
    "work",
  ]);
  const codeVerbs = {
    created: "create",
    generated: "generate",
    indexing: "index",
    selected: "select",
    stored: "store",
    written: "write",
  } satisfies Record<string, string>;
  const terms = (query.match(/[\p{L}\p{N}$]+/gu) ?? []).filter(
    (t) => t.length > 1 && !stopwords.has(t.toLowerCase()),
  );

  if (terms.length === 0) return "";

  // Use prefix matching (*) for each term, joined with OR
  const entry = (term: string) => Object.entries(codeVerbs).find(([k]) => k === term)?.[1];
  return [...new Set(terms.map((term) => entry(term.toLowerCase()) ?? term))]
    .map((term) => `"${term}"*`)
    .join(" OR ");
}
