/**
 * Build empty SQLite databases with the full schema pre-created.
 * Run: bun packages/db/scripts/build-template.ts
 * Output: packages/db/template.sqlite, packages/db/registry-template.sqlite
 *
 * These templates are copied on `openez init` instead of running DDL at runtime,
 * saving ~700ms of bun:sqlite exec() overhead on cold init.
 */
import { Database } from "bun:sqlite";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

import { getFullWorkspaceDdl } from "../src/sqlite/workspace-db";
import { getRegistryDdl } from "../src/sqlite/registry-db";

function buildTemplate(outPath: string, ddl: string) {
  const tmpPath = `${outPath}.tmp`;
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }

  const db = new Database(tmpPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(ddl);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // Remove WAL/SHM — only the main .sqlite file ships
  for (const ext of ["-wal", "-shm"]) {
    const p = tmpPath + ext;
    if (existsSync(p)) unlinkSync(p);
  }

  renameSync(tmpPath, outPath);

  const size = Bun.file(outPath).size;
  console.log(`Built ${path.relative(process.cwd(), outPath)} (${size} bytes)`);
}

const dir = path.join(import.meta.dir, "..");
buildTemplate(path.join(dir, "template.sqlite"), getFullWorkspaceDdl());
buildTemplate(path.join(dir, "registry-template.sqlite"), getRegistryDdl());
