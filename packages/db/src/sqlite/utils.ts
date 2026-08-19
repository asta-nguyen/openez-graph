/**
 * Shared helpers used across the SQLite repository modules.
 *
 * `repository.ts` is being progressively split into focused modules
 * (document-repository, graph-repository, fts-repository, …). These helpers
 * avoid duplicated copies of small utility functions that more than one module
 * needs.
 */

export function safeParseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return (typeof parsed === "object" && parsed !== null ? parsed : fallback) as T;
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
  const codeVerbs: Record<string, string> = {
    created: "create",
    generated: "generate",
    indexing: "index",
    selected: "select",
    stored: "store",
    written: "write",
  };
  const terms = (query.match(/[\p{L}\p{N}$]+/gu) ?? []).filter(
    (t) => t.length > 1 && !stopwords.has(t.toLowerCase()),
  );

  if (terms.length === 0) return "";

  // Use prefix matching (*) for each term, joined with OR
  return [...new Set(terms.map((term) => codeVerbs[term.toLowerCase()] ?? term))]
    .map((term) => `"${term}"*`)
    .join(" OR ");
}
