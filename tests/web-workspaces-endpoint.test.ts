import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebServer } from "../apps/web/src/server/index";
import { closeRegistryDb as closeWebRegistryDb } from "../apps/web/src/server/sqlite";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";

let tempDir: string;
const app = createWebServer();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openez-web-ws-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(tempDir, "registry.sqlite");
  closeRegistryDb();
  closeWebRegistryDb();
  closeAllWorkspaceDbs();
});

afterEach(() => {
  closeAllWorkspaceDbs();
  closeWebRegistryDb();
  closeRegistryDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
});

describe("DELETE /api/workspaces/:id", () => {
  it("removes the registry row and the .openez directory", async () => {
    const root = path.join(tempDir, "victim");
    fs.mkdirSync(path.join(root, ".openez"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openez", "workspace.json"), "{}\n");
    const ws = await createRegistryRepository().createWorkspace({
      id: "victim",
      name: "victim",
      rootPath: root,
    });

    const response = await app.request(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      report: { workspaceId: "victim", unregistered: true, dataDirRemoved: true },
    });
    expect(await createRegistryRepository().getWorkspace("victim")).toBeNull();
    expect(fs.existsSync(path.join(root, ".openez"))).toBe(false);
  });

  it("returns 404 for an unknown workspace", async () => {
    const response = await app.request("/api/workspaces/nope", { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/workspaces/:id/pin", () => {
  it("pins and unpins; list returns pinned first", async () => {
    await createRegistryRepository().createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });
    await createRegistryRepository().createWorkspace({ id: "b", name: "b", rootPath: "/tmp/b" });

    const pin = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(200);

    const listed = await (await app.request("/api/workspaces")).json();
    expect(listed.data[0].id).toBe("a");
    expect(listed.data[0].pinnedAt).toBeTruthy();
    expect(listed.data[1].pinnedAt).toBeNull();

    const unpin = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpin.status).toBe(200);

    const relisted = await (await app.request("/api/workspaces")).json();
    expect(relisted.data[0].pinnedAt).toBeNull();
  });

  it("rejects a non-boolean pinned and an unknown id", async () => {
    await createRegistryRepository().createWorkspace({ id: "a", name: "a", rootPath: "/tmp/a" });

    const bad = await app.request("/api/workspaces/a/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: "yes" }),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/api/workspaces/nope/pin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(missing.status).toBe(404);
  });
});
