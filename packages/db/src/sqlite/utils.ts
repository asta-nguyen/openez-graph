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
 * The search terms of a user query: words and numbers without question/filler stopwords,
 * plain lowercase words reduced to a stem, deduplicated in query order. Shared by the FTS query
 * and the file-name match so both read a question the same way.
 */
export function queryTerms(query: string): string[] {
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
  const irregular: Record<string, string> = { written: "write" };
  // Plain lowercase words drop a plural/-ed/-ing ending so the prefix match below reaches
  // the base form ("truncated" → "truncat"* matches "truncate", "chunks" → "chunk"*).
  // ponytail: suffix stripping, not a real stemmer; swap in Porter if irregulars pile up.
  const stem = (term: string) => {
    if (irregular[term]) return irregular[term];
    if (!/^[a-z]+$/.test(term)) return term;
    const base = term.replace(/(?:ing|ed|(?<!s)s)$/, "");
    return base.length >= 4 ? base : term;
  };
  const terms = (query.match(/[\p{L}\p{N}$]+/gu) ?? []).filter(
    (t) => t.length > 1 && !stopwords.has(t.toLowerCase()),
  );

  return [...new Set(terms.map(stem))];
}

/**
 * Sanitize a user query for FTS5 MATCH.
 * Splits into terms, strips FTS5 special characters, and joins with OR
 * so multi-word queries match any term (broader recall for code search).
 * Falls back to prefix matching for partial words.
 */
export function sanitizeFtsQuery(query: string): string {
  // Use prefix matching (*) for each term, joined with OR
  return queryTerms(query)
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
