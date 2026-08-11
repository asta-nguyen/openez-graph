import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createWebServer } from "../apps/web/src/server/index";
import {
  closeAllWorkspaceDbs,
  closeRegistryDb,
  createRegistryRepository,
} from "../packages/db/src/sqlite";

let registryRoot: string;
let workspaceRoot: string;
let workspaceId: string;

beforeAll(async () => {
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-web-registry-"));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openez-web-workspace-"));
  process.env.AI_MEMORY_REGISTRY_DB_PATH = path.join(registryRoot, "registry.sqlite");
  process.env.EMBEDDING_PROVIDER = "none";
  closeRegistryDb();
  closeAllWorkspaceDbs();

  fs.writeFileSync(path.join(workspaceRoot, "index.ts"), "export const value = 1;\n");
  workspaceId = (await createRegistryRepository().ensureWorkspace({ rootPath: workspaceRoot })).id;
});

afterAll(() => {
  closeAllWorkspaceDbs();
  closeRegistryDb();
  fs.rmSync(registryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.AI_MEMORY_REGISTRY_DB_PATH;
  delete process.env.EMBEDDING_PROVIDER;
});

describe("POST /api/workspaces/:id/index", () => {
  const app = createWebServer();

  it("rejects an invalid mode", async () => {
    const response = await app.request(`/api/workspaces/${workspaceId}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "invalid" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "failed" });
  });

  it("waits for indexing and returns its summary", async () => {
    const response = await app.request(`/api/workspaces/${workspaceId}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "incremental" }),
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      workspaceId,
      filesScanned: 1,
      filesUpdated: 1,
      status: "completed",
    });
    expect((await createRegistryRepository().getWorkspace(workspaceId))?.indexingStatus).toBe(
      "completed",
    );
  });

  it("supports the full reindex mode used by the workspace control", async () => {
    const response = await app.request(`/api/workspaces/${workspaceId}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaceId, status: "completed" });
  });

  it("returns 404 for an unknown workspace", async () => {
    const response = await app.request("/api/workspaces/missing/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "incremental" }),
    });

    expect(response.status).toBe(404);
  });
});

describe("GET /api/metrics", () => {
  const app = createWebServer();

  it("explains how token savings are estimated", async () => {
    const response = await app.request(`/api/metrics?workspaceId=${workspaceId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      metricMethod: "selected-full-files-minus-serialized-response",
    });
  });
});

describe("PUT /api/settings/embedding", () => {
  const app = createWebServer();

  it("rejects local embedding models outside the catalog", async () => {
    const response = await app.request("/api/settings/embedding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "embedding.local_model": "toString" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Unsupported") });
  });

  it("normalizes whitespace around a catalog model", async () => {
    const response = await app.request("/api/settings/embedding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "embedding.local_model": ` ${"jina-code-static-256"} ` }),
    });

    expect(response.status).toBe(200);
    const config = await (await app.request("/api/settings/embedding")).json();
    expect(config.localModel).toBe("jina-code-static-256");
  });
});
