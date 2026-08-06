import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeRegistryDb,
  createRegistryRepository,
  removeWorkspace,
} from "../packages/db/src/sqlite/index";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-remove-test-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
});

afterEach(() => {
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

async function seedWorkspace(id: string, rootPath: string) {
  fs.mkdirSync(path.join(rootPath, ".openez"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, ".openez", "workspace.json"), "{}\n");
  fs.writeFileSync(path.join(rootPath, ".openez", "index.sqlite"), "stub");
  return createRegistryRepository().createWorkspace({ id, name: id, rootPath });
}

describe("removeWorkspace", () => {
  it("removes by id: registry row and .openez dir", async () => {
    const root = path.join(tempDir, "proj-a");
    await seedWorkspace("ws-a", root);

    const report = await removeWorkspace({ id: "ws-a" });

    expect(report).toMatchObject({
      workspaceId: "ws-a",
      unregistered: true,
      dataDirRemoved: true,
    });
    expect(report?.warnings).toEqual([]);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
  });

  it("removes by rootPath", async () => {
    const root = path.join(tempDir, "proj-b");
    await seedWorkspace("ws-b", root);

    const report = await removeWorkspace({ rootPath: root });

    expect(report?.workspaceId).toBe("ws-b");
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
  });

  it("unregisters with a warning when the project dir is already gone", async () => {
    const root = path.join(tempDir, "proj-gone");
    await seedWorkspace("ws-gone", root);
    fs.rmSync(root, { recursive: true, force: true });

    const report = await removeWorkspace({ id: "ws-gone" });

    expect(report?.unregistered).toBe(true);
    expect(report?.dataDirRemoved).toBe(false);
    expect(report?.warnings.length).toBeGreaterThan(0);
    expect(await createRegistryRepository().listWorkspaces()).toHaveLength(0);
  });

  it("returns null for an unknown workspace", async () => {
    expect(await removeWorkspace({ id: "nope" })).toBeNull();
  });
});
