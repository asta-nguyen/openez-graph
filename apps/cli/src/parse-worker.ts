// Bundled worker entry for parallel parse — tsup emits this as
// `dist/parse-worker.cjs`, which `parseInline` resolves next to `cli.cjs`.
// All logic lives in the indexer package; this file exists only so the
// worker_threads boundary has a real file to spawn.
import "@openez-graph/indexer/src/parse-worker";
