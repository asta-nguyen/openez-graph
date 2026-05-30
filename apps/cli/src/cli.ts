import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { Command } from "commander";

import { createRegistryRepository, createWorkspaceRepository, writeLocalWorkspaceConfig } from "@openez-graph/db";
import { indexWorkspace } from "@openez-graph/indexer";

const program = new Command();

program
  .name("openez")
  .description("OpenEZ Graph - Local-first knowledge retrieval system")
  .version("0.2.0");

// ── openez init [path] ──

program
  .command("init")
  .description("Initialize a workspace at the given path and run initial index")
  .argument("[path]", "path to the project directory", process.cwd())
  .option("--no-index", "skip initial indexing")
  .action(async (targetPath, options) => {
    const resolvedPath = path.resolve(targetPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: path does not exist: ${resolvedPath}`);
      process.exit(1);
    }

    if (!fs.statSync(resolvedPath).isDirectory()) {
      console.error(`Error: path is not a directory: ${resolvedPath}`);
      process.exit(1);
    }

    const registry = createRegistryRepository();
    const existing = await registry.getWorkspaceByPath(resolvedPath);

    if (existing) {
      await writeLocalWorkspaceConfig(existing);
      console.log(`Workspace '${existing.name}' (${existing.id}) already registered at ${resolvedPath}`);
      if (options.index !== false) {
        console.log("Running initial index...");
        const summary = await indexWorkspace({ rootPath: resolvedPath, mode: "incremental" });
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const workspace = await registry.ensureWorkspace({
      rootPath: resolvedPath
    });
    await writeLocalWorkspaceConfig(workspace);

    console.log(`Workspace '${workspace.name}' (${workspace.id}) initialized at ${resolvedPath}`);

    if (options.index !== false) {
      console.log("Running initial index...");
      const summary = await indexWorkspace({ rootPath: resolvedPath, mode: "incremental" });
      console.log(JSON.stringify(summary, null, 2));
    }
  });

// ── openez index [path] ──

program
  .command("index")
  .description("Index files in a workspace")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .action(async (targetPath) => {
    const resolvedPath = path.resolve(targetPath);
    const registry = createRegistryRepository();

    let workspace = await registry.getWorkspaceByPath(resolvedPath);

    if (!workspace) {
      workspace = await registry.ensureWorkspace({
        rootPath: resolvedPath
      });
      console.log(`Auto-registered workspace '${workspace.name}' (${workspace.id})`);
    }

    const summary = await indexWorkspace({ workspaceId: workspace.id });
    console.log(JSON.stringify(summary, null, 2));
  });

// ── openez reindex [path] ──

program
  .command("reindex")
  .description("Full rebuild of a workspace index")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .action(async (targetPath) => {
    const resolvedPath = path.resolve(targetPath);
    const registry = createRegistryRepository();

    let workspace = await registry.getWorkspaceByPath(resolvedPath);
    if (!workspace) {
      console.error(`Error: no workspace registered at ${resolvedPath}. Run 'openez init' first.`);
      process.exit(1);
    }

    const summary = await indexWorkspace({ workspaceId: workspace.id, mode: "full" });
    console.log(JSON.stringify(summary, null, 2));
  });

// ── openez watch [path] ──

program
  .command("watch")
  .description("Watch files and re-index on changes")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .action(async (targetPath) => {
    const resolvedPath = path.resolve(targetPath);
    const registry = createRegistryRepository();

    let workspace = await registry.getWorkspaceByPath(resolvedPath);
    if (!workspace) {
      workspace = await registry.ensureWorkspace({
        rootPath: resolvedPath
      });
      console.log(`Auto-registered workspace '${workspace.name}' (${workspace.id})`);
    }

    console.log(`Running initial index for ${resolvedPath}...`);
    await indexWorkspace({ workspaceId: workspace.id });

    const watcher = chokidar.watch(resolvedPath, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.openez/**"
      ],
      ignoreInitial: true,
      persistent: true
    });

    const reindex = async () => {
      console.log("Change detected, re-indexing...");
      const summary = await indexWorkspace({ workspaceId: workspace.id });
      console.log(JSON.stringify(summary, null, 2));
    };

    watcher.on("add", reindex);
    watcher.on("change", reindex);
    watcher.on("unlink", reindex);

    console.log(`Watching ${resolvedPath} for changes...`);
  });

// ── openez serve ──

program
  .command("serve")
  .description("Start the web dashboard or MCP server")
  .option("--mcp", "run as MCP server instead of web")
  .option("-p, --path <path>", "workspace path")
  .action(async (options) => {
    if (options.mcp) {
      const { startMcpServer } = await import("./mcp-bridge");
      await startMcpServer(options.path ? path.resolve(options.path) : undefined);
    } else {
      console.log("Default local workflow:");
      console.log("  1. openez init <path>");
      console.log("  2. openez index <path>");
      console.log("  3. openez serve --mcp");
      console.log("");
      console.log("To run the management UI separately:");
      console.log("  pnpm dev:web");
    }
  });

// ── openez status [path] ──

program
  .command("status")
  .description("Show workspace status")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .action(async (targetPath) => {
    const resolvedPath = path.resolve(targetPath);
    const registry = createRegistryRepository();

    const workspace = await registry.getWorkspaceByPath(resolvedPath);
    if (!workspace) {
      console.log(`No workspace registered at ${resolvedPath}`);
      console.log("Run 'openez init <path>' to create one.");
      return;
    }

    const repo = createWorkspaceRepository(workspace.rootPath);
    const docCount = await repo.getDocumentCount();
    const chunkCountResult = await repo.getChunkCount();
    const nodeCount = await repo.getNodeCount();
    const edgeCount = await repo.getEdgeCount();

    console.log(`Workspace: ${workspace.name} (${workspace.id})`);
    console.log(`  Path:      ${workspace.rootPath}`);
    console.log(`  Status:    ${workspace.status}`);
    console.log(`  Index:     ${workspace.indexingStatus}`);
    console.log(`  Documents: ${docCount}`);
    console.log(`  Chunks:    ${chunkCountResult}`);
    console.log(`  Nodes:     ${nodeCount}`);
    console.log(`  Edges:     ${edgeCount}`);
    if (workspace.lastIndexedAt) {
      console.log(`  Last indexed: ${workspace.lastIndexedAt}`);
    }
    if (workspace.lastError) {
      console.log(`  Last error: ${workspace.lastError}`);
    }
  });

// ── openez list ──

program
  .command("list")
  .description("List all registered workspaces")
  .action(async () => {
    const registry = createRegistryRepository();
    const workspaces = await registry.listWorkspaces();

    if (workspaces.length === 0) {
      console.log("No workspaces registered.");
      console.log("Run 'openez init <path>' to create one.");
      return;
    }

    console.log("Registered workspaces:");
    for (const workspace of workspaces) {
      const statusIcon = workspace.status === "indexed" ? "✓" : workspace.status === "error" ? "✗" : "○";
      console.log(`  ${statusIcon} ${workspace.name} (${workspace.id})`);
      console.log(`       ${workspace.rootPath}`);
    }
  });

// ── openez setup codex|claude|opencode [path] ──

const setup = program.command("setup").description("Configure editor/agent integrations (codex, claude, opencode)");

setup
  .command("codex")
  .description("Add or update the shared OpenEZ MCP server entry in ~/.codex/config.toml")
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupCodex } = await import("./setup-codex");
    await setupCodex(targetPath);
  });

setup
  .command("claude")
  .description("Add or update the shared OpenEZ MCP server entry in ~/.claude/settings.json")
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupClaude } = await import("./setup-claude");
    await setupClaude(targetPath);
  });

setup
  .command("opencode")
  .description("Add or update the shared OpenEZ MCP server entry in ~/.config/opencode/opencode.json")
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupOpenCode } = await import("./setup-opencode");
    await setupOpenCode(targetPath);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
