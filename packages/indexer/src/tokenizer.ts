// The indexer previously carried its own chars/4 token helpers. Token
// counting is now scoped via the TokenCounter interface in @openez-graph/core
// (fastTokenCounter for indexing, exactTokenCounter for retrieval). Re-export
// the scoped counters so any indexer code that needs a counter imports from a
// single source of truth.
export {
  countTokens,
  exactTokenCounter,
  fastTokenCounter,
  splitApproximately,
  splitToTokenLimit,
  truncateToTokenLimit,
  type TokenCounter,
} from "@openez-graph/core";
