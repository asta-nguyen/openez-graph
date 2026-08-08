import { describe, expect, it } from "bun:test";

import { indexConfig } from "../packages/indexer/src/languages";

describe("config indexing", () => {
  it("chunks YAML by top-level keys", () => {
    const chunks = indexConfig("service:\n  port: 3000\ndatabase:\n  host: localhost\n", "yaml");

    expect(chunks.map((chunk) => chunk.heading)).toEqual(["service", "database"]);
  });

  it("chunks JSON by top-level keys", () => {
    const chunks = indexConfig('{"service":{"port":3000},"enabled":true}', "json");

    expect(chunks.map((chunk) => chunk.heading)).toEqual(["service", "enabled"]);
  });

  it("marks TOML array tables", () => {
    const chunks = indexConfig('[package]\nname = "app"\n[[bin]]\nname = "cli"\n', "toml");

    expect(chunks.map((chunk) => chunk.heading)).toEqual(["package", "bin"]);
    expect(chunks[1].metadata.arrayTable).toBe(true);
  });
});
