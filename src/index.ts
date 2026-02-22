import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { ensureAuth } from "./auth";
import { createShadowAgent, createWorkerAgent } from "./agent";
import { startWatcher } from "./watcher";
import { findFilesWithUnresolvedImports, findFilesWithTypeHoles } from "./filter";
import { logger } from "./logger";
import { partitionWork } from "./parallel";
import { authenticateMcpServers } from "./mcp/connect";

function parseArgs(): {
  projectRoot: string;
  scopeDir: string;
  debounceMs: number;
  verbose: boolean;
  dryRun: boolean;
  maxParallel: number;
} {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  let scopeDir: string | null = null;
  let debounceMs = 1500;
  let verbose = false;
  let dryRun = false;
  let maxParallel = 1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" && args[i + 1]) {
      scopeDir = args[++i];
    } else if (arg === "--debounce" && args[i + 1]) {
      debounceMs = parseInt(args[++i], 10);
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--parallel") {
      // --parallel or --parallel 4
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        maxParallel = parseInt(args[++i], 10);
      } else {
        maxParallel = 3;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: shadow [project-root] [options]");
      console.log();
      console.log("Options:");
      console.log("  --scope <dir>     Write boundary for the agent (default: project root)");
      console.log("  --debounce <ms>   Debounce delay in ms (default: 1500)");
      console.log("  --verbose, -v     Show agent reasoning");
      console.log("  --dry-run         Preview without writing files");
      console.log("  --parallel [n]    Max parallel agents (default: 3)");
      console.log("  --help, -h        Show this help");
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      projectRoot = arg;
    }
  }

  projectRoot = resolve(projectRoot);
  scopeDir = resolve(scopeDir ?? projectRoot);

  if (!existsSync(projectRoot)) {
    logger.error(`Project root does not exist: ${projectRoot}`);
    process.exit(1);
  }

  return { projectRoot, scopeDir, debounceMs, verbose, dryRun, maxParallel };
}

async function main() {
  const { projectRoot, scopeDir, debounceMs, verbose, dryRun, maxParallel } = parseArgs();

  await ensureAuth();

  logger.banner(projectRoot, scopeDir);
  if (dryRun) {
    logger.dryRunBanner();
  }

  // Load AGENTS.md if present (not handled by the SDK)
  const agentsMdPath = join(projectRoot, "AGENTS.md");
  let agentsInstructions: string | undefined;
  if (existsSync(agentsMdPath)) {
    const content = await Bun.file(agentsMdPath).text();
    if (content.trim()) {
      agentsInstructions = content;
      if (verbose) {
        logger.verbose("loaded AGENTS.md");
      }
    }
  }

  // Authenticate remote MCP servers via OAuth (if any in .mcp.json)
  const mcpServers = await authenticateMcpServers(projectRoot, verbose);

  // Start watcher first, then create agent with watcher reference.
  // The callback captures `agent` by closure - it's assigned before
  // any file change can fire (debounce ensures a delay).
  let agent: ReturnType<typeof createShadowAgent>;
  let running = false;
  let queued = false;
  let lastChangedFiles: string[] = [];

  const watcher = startWatcher(
    projectRoot,
    scopeDir,
    (changedFiles) => onTrigger(changedFiles),
    debounceMs,
  );

  const MAX_CASCADE_DEPTH = 3;

  agent = createShadowAgent({ projectRoot, scopeDir, verbose, watcher, dryRun, agentsInstructions, mcpServers });

  async function onTrigger(changedFiles: string[], cascadeDepth = 0) {
    if (running && cascadeDepth === 0) {
      queued = true;
      lastChangedFiles = changedFiles;
      return;
    }

    // Pre-filter: skip the agent if all imports resolve and no type holes
    const unresolved = await findFilesWithUnresolvedImports(
      changedFiles,
      projectRoot,
    );
    // Only check type holes on user-triggered files, not cascade iterations
    const typeHoles = cascadeDepth === 0
      ? await findFilesWithTypeHoles(changedFiles)
      : [];

    if (unresolved.length === 0 && typeHoles.length === 0) {
      if (verbose) {
        logger.verbose("all imports resolve, no type holes, skipping agent");
      }
      return;
    }

    running = true;

    if (cascadeDepth > 0) {
      logger.cascade(cascadeDepth, changedFiles);
    } else {
      logger.trigger(changedFiles);
    }

    for (const { file, unresolved: imports } of unresolved) {
      const name = file.split("/").pop();
      logger.verbose(`${name}: missing ${imports.join(", ")}`);
    }
    for (const { file, holes } of typeHoles) {
      const name = file.split("/").pop();
      logger.verbose(`${name}: ${holes.length} type hole(s)`);
    }

    try {
      let allWrittenFiles: string[];

      // Decide serial vs parallel
      const groups = maxParallel > 1
        ? partitionWork(changedFiles, unresolved, typeHoles, maxParallel)
        : [{ id: 0, changedFiles, unresolvedHints: unresolved, typeHoleHints: typeHoles }];

      if (groups.length > 1) {
        // Parallel path
        logger.parallelStart(groups.length);

        const workers = groups.map((group) =>
          createWorkerAgent({
            projectRoot,
            scopeDir,
            verbose,
            watcher,
            dryRun,
            workerId: group.id,
            agentsInstructions,
            mcpServers,
          }),
        );

        const results = await Promise.all(
          groups.map((group, i) =>
            workers[i].run(
              group.changedFiles,
              group.unresolvedHints.length > 0 ? group.unresolvedHints : undefined,
              group.typeHoleHints.length > 0 ? group.typeHoleHints : undefined,
            ),
          ),
        );

        allWrittenFiles = results.flat();
        logger.parallelDone(groups.length, allWrittenFiles.length);
      } else {
        // Serial path (default)
        allWrittenFiles = await agent.run(
          changedFiles,
          unresolved.length > 0 ? unresolved : undefined,
          typeHoles.length > 0 ? typeHoles : undefined,
        );
      }

      // Cascade: check written files for their own unresolved imports
      if (allWrittenFiles.length > 0 && cascadeDepth < MAX_CASCADE_DEPTH) {
        const cascadeUnresolved = await findFilesWithUnresolvedImports(
          allWrittenFiles,
          projectRoot,
        );
        if (cascadeUnresolved.length > 0) {
          if (verbose) {
            logger.verbose(
              `cascade depth ${cascadeDepth + 1}: ${cascadeUnresolved.length} file(s) with unresolved imports`,
            );
          }
          await onTrigger(allWrittenFiles, cascadeDepth + 1);
          return;
        }
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
    }

    running = false;

    if (cascadeDepth === 0) {
      if (queued) {
        queued = false;
        const files = lastChangedFiles;
        lastChangedFiles = [];
        await onTrigger(files);
      } else {
        logger.watching();
      }
    }
  }

  logger.watching();

  const shutdown = () => {
    console.log();
    logger.verbose("shutting down...");
    watcher.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
