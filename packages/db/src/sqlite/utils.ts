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

/**
 * Map an internal `symbolType` marker to the public kind vocabulary.
 * The tree-sitter parsers emit `static_method`/`static_function` on
 * `parsed_documents.symbols` so the C#/Java resolvers can restrict
 * `using static`/`import static` to genuinely static members; outline
 * `kind` labels, chunk metadata, and graph-node metadata keep the base
 * vocabulary so public shapes never see the internal distinction.
 */
export function publicSymbolKind(kind: string): string {
  if (kind === "static_method") return "method";
  if (kind === "static_function") return "function";
  return kind;
}
