import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import chokidar from "chokidar";
import { Command } from "commander";

import {
  createRegistryRepository,
  createWorkspaceRepository,
  findLocalWorkspaceConfig,
  getLocalWorkspaceDir,
  isSensitiveKey,
  removeWorkspace,
  writeLocalWorkspaceConfig,
  readLocalWorkspaceConfig,
} from "@openez-graph/db";
import { embedWorkspace, ensureGraphReady, indexWorkspace } from "@openez-graph/indexer";
import {
  analyzeDiffContext,
  isLocalEmbeddingModel,
  LOCAL_EMBEDDING_MODELS,
} from "@openez-graph/core";

let cliDir: string;
try {
  cliDir = path.dirname(fs.realpathSync(process.argv[1]));
} catch {
  // Compiled binary (bun build --compile) — process.argv[1] is virtual
  cliDir = process.cwd();
}
let pkg: { version: string };
try {
  pkg = JSON.parse(fs.readFileSync(path.resolve(cliDir, "../package.json"), "utf-8"));
} catch {
  pkg = { version: "0.0.0-compiled" };
}

const program = new Command();

program
  .name("openez")
  .description("OpenEZ Graph - Local-first knowledge retrieval system")
  .version(pkg.version);

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
      console.log(
        `Workspace '${existing.name}' (${existing.id}) already registered at ${resolvedPath}`,
      );
      if (options.index !== false) {
        console.log("Running initial index...");
        const summary = await indexWorkspace({ rootPath: resolvedPath, mode: "incremental" });
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const workspace = await registry.ensureWorkspace({
      rootPath: resolvedPath,
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

    // Fast path: read workspace.json directly (avoids opening registry DB)
    let workspace = await readLocalWorkspaceConfig(resolvedPath);

    if (!workspace) {
      // Fallback: registry lookup or auto-register
      const registry = createRegistryRepository();
      let regWorkspace = await registry.getWorkspaceByPath(resolvedPath);
      if (!regWorkspace) {
        regWorkspace = await registry.ensureWorkspace({ rootPath: resolvedPath });
        console.log(`Auto-registered workspace '${regWorkspace.name}' (${regWorkspace.id})`);
      }
      await writeLocalWorkspaceConfig(regWorkspace);
      workspace = {
        workspaceId: regWorkspace.id,
        rootPath: regWorkspace.rootPath,
        name: regWorkspace.name,
        updatedAt: new Date().toISOString(),
      };
    }

    const summary = await indexWorkspace({ rootPath: resolvedPath });
    console.log(JSON.stringify(summary, null, 2));
  });

// ── openez embed [path] ──

program
  .command("embed")
  .description("Create embeddings for indexed workspace chunks")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .option("--force", "delete and rebuild vectors for the active provider/model")
  .action(async (targetPath, options) => {
    const resolvedPath = path.resolve(targetPath);
    let workspace = await readLocalWorkspaceConfig(resolvedPath);
    if (!workspace) {
      const registry = createRegistryRepository();
      const registered = await registry.getWorkspaceByPath(resolvedPath);
      if (!registered) {
        console.error(
          `Error: no workspace registered at ${resolvedPath}. Run 'openez init' first.`,
        );
        process.exit(1);
      }
      await writeLocalWorkspaceConfig(registered);
      workspace = {
        workspaceId: registered.id,
        rootPath: registered.rootPath,
        name: registered.name,
        updatedAt: new Date().toISOString(),
      };
    }

    const summary = await embedWorkspace({
      workspaceId: workspace.workspaceId,
      force: options.force,
      onProgress: (progress) => console.log(`[${progress.progress}%] ${progress.message}`),
    });
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

    await writeLocalWorkspaceConfig(workspace);

    const summary = await indexWorkspace({
      workspaceId: workspace.id,
      mode: "full",
      onProgress: (p) => console.log(`[${p.progress}%] ${p.message}`),
    });
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
        rootPath: resolvedPath,
      });
      console.log(`Auto-registered workspace '${workspace.name}' (${workspace.id})`);
    }

    await writeLocalWorkspaceConfig(workspace);
    const workspaceId = workspace.id;

    console.log(`Running initial index for ${resolvedPath}...`);
    await indexWorkspace({ workspaceId });

    const watcher = chokidar.watch(resolvedPath, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.openez/**",
      ],
      ignoreInitial: true,
      persistent: true,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let isIndexing = false;
    let hasPendingChange = false;

    const runReindex = async () => {
      if (isIndexing) {
        hasPendingChange = true;
        return;
      }

      isIndexing = true;

      do {
        hasPendingChange = false;
        console.log("Change detected, re-indexing...");
        try {
          const summary = await indexWorkspace({ workspaceId });
          console.log(JSON.stringify(summary, null, 2));
        } catch (error) {
          console.error("Re-index failed:");
          console.error(error);
        }
      } while (hasPendingChange);

      isIndexing = false;
    };

    const scheduleReindex = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        void runReindex();
      }, 250);
    };

    watcher.on("add", scheduleReindex);
    watcher.on("change", scheduleReindex);
    watcher.on("unlink", scheduleReindex);

    console.log(`Watching ${resolvedPath} for changes...`);
  });

// ── openez serve ──

program
  .command("serve")
  .description("Start the web dashboard or MCP server")
  .option("--mcp", "run as MCP server instead of web")
  .option("--web", "start the web dashboard API server")
  .option("-p, --path <path>", "workspace path")
  .option("--port <port>", "API server port (default: 11368)")
  .action(async (options) => {
    if (options.mcp) {
      const { startMcpServer } = await import("./mcp-bridge");
      await startMcpServer(options.path ? path.resolve(options.path) : undefined, pkg.version);
    } else if (options.web) {
      const port = options.port ? Number(options.port) : Number(process.env.API_PORT ?? 11368);
      process.env.API_PORT = String(port);
      const { serve } = await import("@hono/node-server");
      const { createWebServer } = await import("./web-server");
      const app = createWebServer();
      serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
        console.log(`OpenEZ Graph web dashboard:`);
        console.log(`  http://${info.address}:${info.port}`);
        console.log(`  Press Ctrl+C to stop`);
      });
    } else {
      console.log("Default local workflow:");
      console.log("  1. openez init <path>");
      console.log("  2. openez index <path>");
      console.log("  3. openez serve --mcp     # start MCP server");
      console.log("  4. openez serve --web     # start web dashboard API");
      console.log("");
      console.log("To run the management UI with frontend:");
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

// ── openez diff [ref] ──

program
  .command("diff")
  .description("Analyze git diff and extract affected AST symbols and caller graph context")
  .argument("[ref]", "Git ref or commit range (e.g. HEAD~1, origin/main)")
  .option("-s, --staged", "Inspect staged git changes")
  .option("-j, --json", "Output JSON review context bundle")
  .option("-l, --limit <number>", "Maximum callers and callees to display per symbol", "5")
  .action(async (ref, options) => {
    const parsedLimit = Number(options.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      console.error(`Error: --limit must be a positive integer, got '${options.limit}'`);
      process.exit(1);
    }

    const localConfig = await findLocalWorkspaceConfig(process.cwd());
    const rootPath = localConfig ? localConfig.rootPath : process.cwd();
    const registry = createRegistryRepository();
    const workspace = localConfig
      ? await registry.getWorkspace(localConfig.workspaceId)
      : await registry.getWorkspaceByPath(rootPath);
    if (!workspace) {
      console.error(`Error: no workspace registered at ${rootPath}. Run 'openez init' first.`);
      process.exit(1);
    }

    await indexWorkspace({ workspaceId: workspace.id, mode: "incremental" });
    await ensureGraphReady(workspace.id);
    const report = await analyzeDiffContext(workspace.rootPath, {
      ref,
      staged: Boolean(options.staged),
      limit: parsedLimit,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(report.formattedSummary);
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
      const statusIcon =
        workspace.status === "indexed" ? "✓" : workspace.status === "error" ? "✗" : "○";
      const pinMarker = workspace.pinnedAt ? " 📌" : "";
      console.log(`  ${statusIcon}${pinMarker} ${workspace.name} (${workspace.id})`);
      console.log(`       ${workspace.rootPath}`);
    }
  });

// ── openez remove [path] ──

function confirmDestructive(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    return Promise.reject(new Error("Confirmation required; rerun with --yes."));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

program
  .command("remove")
  .alias("rm")
  .description("Remove a workspace from the registry and delete its .openez data directory")
  .argument("[path]", "path to the workspace directory", process.cwd())
  .option("--id <workspaceId>", "workspace id (takes precedence over path)")
  .option("-y, --yes", "skip confirmation prompt")
  .action(async (targetPath, options) => {
    const registry = createRegistryRepository();
    const resolvedPath = path.resolve(targetPath);
    const workspace = options.id
      ? await registry.getWorkspace(options.id)
      : await registry.getWorkspaceByPath(resolvedPath);

    if (!workspace) {
      console.error(`Error: no registered workspace found for ${options.id ?? resolvedPath}`);
      process.exit(1);
    }

    const dataDir = getLocalWorkspaceDir(workspace.rootPath);
    console.log(`Workspace: ${workspace.name} (${workspace.id})`);
    console.log(`  Path:     ${workspace.rootPath}`);
    console.log(`  Data dir: ${dataDir}`);
    console.log(`  Indexed:  ${workspace.documentCount} docs, ${workspace.chunkCount} chunks`);
    console.log(
      "This removes the registry entry and deletes the data directory. Source code is not touched.",
    );

    if (!options.yes) {
      const confirmed = await confirmDestructive("Proceed?");
      if (!confirmed) {
        console.log("Aborted.");
        return;
      }
    }

    const report = await removeWorkspace({ id: workspace.id });
    if (!report) {
      console.error(`Error: workspace '${workspace.id}' no longer exists in the registry.`);
      process.exit(1);
    }

    if (report.unregistered) {
      console.log(`✓ Unregistered workspace ${report.workspaceId}`);
    } else {
      console.log(`✗ Workspace ${report.workspaceId} could not be unregistered (see warnings)`);
    }
    if (report.dataDirRemoved) {
      console.log(`✓ Deleted ${report.dataDirPath}`);
    }
    for (const warning of report.warnings) {
      console.log(`! ${warning}`);
    }
  });

// ── openez config ──

const EMBEDDING_CONFIG_KEYS = [
  "embedding.provider",
  "embedding.openai_api_key",
  "embedding.openai_base_url",
  "embedding.openai_model",
  "embedding.ollama_base_url",
  "embedding.ollama_model",
  "embedding.local_model",
] as const;

const configCmd = program
  .command("config")
  .description("Manage embedding configuration stored in the registry DB");

configCmd
  .command("get [key]")
  .description("Get a config value (or all if no key given)")
  .action(async (key?: string) => {
    const registry = createRegistryRepository();
    if (key) {
      const { getEmbeddingConfig } = await import("@openez-graph/core");
      const config = await getEmbeddingConfig();
      const configMap: Record<string, string | undefined> = {
        "embedding.provider": config.provider,
        "embedding.openai_api_key": config.openaiApiKey || undefined,
        "embedding.openai_base_url": config.openaiBaseUrl,
        "embedding.openai_model": config.openaiModel,
        "embedding.ollama_base_url": config.ollamaBaseUrl,
        "embedding.ollama_model": config.ollamaModel,
        "embedding.local_model": config.localModel,
      };
      const value = configMap[key];
      if (value === undefined || value === "") {
        console.log("not set");
      } else if (isSensitiveKey(key)) {
        console.log("****");
      } else {
        console.log(value);
      }
    } else {
      const all = await registry.getAllSettings();
      if (Object.keys(all).length === 0) {
        console.log("No config values set. Showing env defaults:");
      }
      const { getEmbeddingConfig } = await import("@openez-graph/core");
      const config = await getEmbeddingConfig();
      console.log("  Embedding provider:    " + config.provider);
      console.log("  OpenAI API key:        " + (config.openaiApiKey ? "****" : "not set"));
      console.log("  OpenAI base URL:       " + (config.openaiBaseUrl ?? "default"));
      console.log("  OpenAI model:          " + config.openaiModel);
      console.log("  Ollama base URL:       " + config.ollamaBaseUrl);
      console.log("  Ollama model:          " + config.ollamaModel);
      console.log("  Local model:           " + config.localModel);
      if (Object.keys(all).length > 0) {
        console.log("");
        console.log("DB-stored overrides:");
        for (const [k, v] of Object.entries(all)) {
          const display = isSensitiveKey(k) ? "****" : v;
          console.log(`  ${k} = ${display}`);
        }
      }
    }
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value. Keys: " + EMBEDDING_CONFIG_KEYS.join(", "))
  .action(async (key: string, value: string) => {
    if (!EMBEDDING_CONFIG_KEYS.includes(key as (typeof EMBEDDING_CONFIG_KEYS)[number])) {
      console.error(`Error: unknown key '${key}'. Valid keys:`);
      for (const k of EMBEDDING_CONFIG_KEYS) {
        console.error(`  ${k}`);
      }
      process.exit(1);
    }
    const registry = createRegistryRepository();
    if (key === "embedding.provider" && !["none", "openai", "ollama", "local"].includes(value)) {
      console.error("Error: embedding.provider must be one of: none, openai, ollama, local");
      process.exit(1);
    }
    if (key === "embedding.local_model" && !isLocalEmbeddingModel(value)) {
      console.error("Error: embedding.local_model '" + value + "' is not supported.");
      console.error("Supported models: " + Object.keys(LOCAL_EMBEDDING_MODELS).join(", "));
      process.exit(1);
    }
    await registry.setSetting(key, value);
    console.log(`Set ${key} = ${isSensitiveKey(key) ? "****" : value}`);
  });

configCmd
  .command("list")
  .description("List all config values (same as 'config get' without key)")
  .action(async () => {
    const registry = createRegistryRepository();
    const all = await registry.getAllSettings();
    if (Object.keys(all).length === 0) {
      console.log("No DB-stored config values. Using env defaults.");
    } else {
      for (const [k, v] of Object.entries(all)) {
        const display = isSensitiveKey(k) ? "****" : v;
        console.log(`${k} = ${display}`);
      }
    }
  });

// ── openez setup codex|claude|opencode [path] ──

const setup = program
  .command("setup")
  .description("Configure editor/agent integrations (codex, claude, opencode, windsurf, devin)");

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
  .description(
    "Add or update the shared OpenEZ MCP server entry in ~/.config/opencode/opencode.json",
  )
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupOpenCode } = await import("./setup-opencode");
    await setupOpenCode(targetPath);
  });

setup
  .command("windsurf")
  .description(
    "Add or update the shared OpenEZ MCP server entry in ~/.codeium/windsurf/mcp_config.json",
  )
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupWindsurf } = await import("./setup-windsurf");
    await setupWindsurf(targetPath);
  });

setup
  .command("devin")
  .description("Add or update the shared OpenEZ MCP server entry in ~/.config/devin/config.json")
  .argument("[path]", "path to the project directory", process.cwd())
  .action(async (targetPath) => {
    const { setupDevin } = await import("./setup-devin");
    await setupDevin(targetPath);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
