import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The codebase targets Bun in production (`bun:sqlite` + `drizzle-orm/bun-sqlite`).
// vitest runs under node, where the `bun:` scheme is unsupported and breaks test
// collection for any test that transitively imports the indexer (which pulls in
// `@openez-graph/core` -> `@openez-graph/db`). Alias `bun:sqlite` to a lightweight
// stub so modules load; the stub is only exercised by tests that actually open a
// database.
export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": path.resolve(__dirname, "tests/__mocks__/bun-sqlite.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Inline modules that import `bun:sqlite` so vite's resolve.alias
        // (which stubs `bun:sqlite`) is applied. Without inlining, vitest
        // externalizes node_modules and node's native loader rejects `bun:`.
        inline: [/drizzle-orm/, /@openez-graph\/db/, /@openez-graph\/core/],
      },
    },
  },
});
