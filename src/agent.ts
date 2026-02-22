import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  PreToolUseHookInput,
  PostToolUseHookInput,
  HookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createScopeHook } from "./scope";
import { systemPrompt, buildPrompt, buildWorkerPrompt } from "./prompt";
import { logger } from "./logger";
import type { WatcherHandle } from "./watcher";
import type { McpServersMap } from "./mcp/connect";

export type UnresolvedHint = { file: string; unresolved: string[] };
export type { TypeHoleResult } from "./filter";

export type ShadowAgent = {
  run(
    changedFiles: string[],
    unresolvedHints?: UnresolvedHint[],
    typeHoleHints?: import("./filter").TypeHoleResult[],
  ): Promise<string[]>;
  getSessionId(): string | undefined;
};

export function createShadowAgent(options: {
  projectRoot: string;
  scopeDir: string;
  verbose: boolean;
  watcher?: WatcherHandle;
  dryRun?: boolean;
  agentsInstructions?: string;
  mcpServers?: McpServersMap;
}): ShadowAgent {
  const { projectRoot, scopeDir, verbose, watcher, dryRun = false, agentsInstructions, mcpServers } = options;

  let sessionId: string | undefined;
  let currentTriggerFiles: string[] = [];
  let currentAllowedEditFiles: string[] = [];

  const scopeHook = createScopeHook(
    scopeDir,
    () => currentTriggerFiles,
    () => currentAllowedEditFiles,
  );

  // Tracks files written during the current run (for cascade triggers)
  let writtenFiles = new Set<string>();

  // Dry-run: snapshot files before Write/Edit so we can revert after
  const dryRunSnapshots = new Map<string, string | null>();
  let dryRunFileCount = 0;

  const dryRunPreHook = async (
    input: HookInput,
  ): Promise<SyncHookJSONOutput> => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (!filePath) return {};

    try {
      if (existsSync(filePath)) {
        const content = await Bun.file(filePath).text();
        dryRunSnapshots.set(filePath, content);
      } else {
        dryRunSnapshots.set(filePath, null);
      }
    } catch {
      dryRunSnapshots.set(filePath, null);
    }

    return {};
  };

  const dryRunPostHook = async (
    input: HookInput,
  ): Promise<SyncHookJSONOutput> => {
    const postInput = input as PostToolUseHookInput;
    const toolInput = postInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (!filePath) return {};

    // Read what was written for preview
    try {
      const newContent = await Bun.file(filePath).text();
      const isNew = dryRunSnapshots.get(filePath) === null;
      logger.dryRunPreview(filePath, newContent, isNew);
      dryRunFileCount++;
    } catch {
      // File may not exist
    }

    // Revert the write
    const snapshot = dryRunSnapshots.get(filePath);
    if (snapshot === null || snapshot === undefined) {
      // File was newly created - delete it
      try {
        unlinkSync(filePath);
      } catch {
        // Already gone
      }
    } else {
      // File existed - restore original
      await Bun.write(filePath, snapshot);
    }

    dryRunSnapshots.delete(filePath);
    return {};
  };

  // Hook to log and track writes for feedback loop prevention
  const writeTrackingHook = async (
    input: HookInput,
  ): Promise<SyncHookJSONOutput> => {
    const postInput = input as PostToolUseHookInput;
    const toolInput = postInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (filePath) {
      logger.fileWritten(filePath);
      watcher?.addWrittenFile(filePath);
      writtenFiles.add(filePath);
    }

    return {};
  };

  async function run(
    changedFiles: string[],
    unresolvedHints?: UnresolvedHint[],
    typeHoleHints?: import("./filter").TypeHoleResult[],
  ): Promise<string[]> {
    currentTriggerFiles = changedFiles;
    currentAllowedEditFiles = (typeHoleHints ?? []).map((h) => h.file);
    writtenFiles = new Set();
    dryRunSnapshots.clear();
    dryRunFileCount = 0;

    logger.agentStart();

    const prompt = await buildPrompt(changedFiles, projectRoot, unresolvedHints, typeHoleHints);

    const response = query({
      prompt,
      options: {
        cwd: projectRoot,
        systemPrompt: systemPrompt(projectRoot, agentsInstructions),
        settingSources: ["project"],
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 20,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [scopeHook, ...(dryRun ? [dryRunPreHook] : [])],
            },
          ],
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [
                ...(dryRun ? [] : [writeTrackingHook]),
                ...(dryRun ? [dryRunPostHook] : []),
              ],
            },
          ],
        },
      },
    });

    for await (const message of response) {
      handleMessage(message, verbose);
    }

    if (dryRun && dryRunFileCount > 0) {
      logger.dryRunSummary(dryRunFileCount);
    }

    currentTriggerFiles = [];
    return dryRun ? [] : [...writtenFiles];
  }

  function handleMessage(message: SDKMessage, verbose: boolean) {
    switch (message.type) {
      case "system": {
        const sys = message as SDKSystemMessage;
        if (sys.subtype === "init") {
          sessionId = sys.session_id;
          if (verbose) {
            logger.verbose(`session: ${sessionId}`);
            logger.verbose(`model: ${sys.model}`);
          }
        }
        break;
      }

      case "assistant": {
        const asst = message as SDKAssistantMessage;
        if (verbose && asst.message.content) {
          for (const block of asst.message.content) {
            if ("type" in block && block.type === "text" && "text" in block) {
              const text = (block as { type: "text"; text: string }).text;
              if (text.length > 200) {
                logger.verbose(text.slice(0, 200) + "...");
              } else {
                logger.verbose(text);
              }
            }
            if ("type" in block && block.type === "tool_use") {
              const tool = block as {
                type: "tool_use";
                name: string;
                input: Record<string, unknown>;
              };
              const filePath = tool.input?.file_path as string | undefined;
              logger.toolCall(tool.name, filePath);
            }
          }
        }
        break;
      }

      case "result": {
        const res = message as SDKResultMessage;
        if (res.subtype === "success") {
          logger.done(res.duration_ms, res.total_cost_usd);
        } else {
          logger.error(
            `Agent finished with ${res.subtype} after ${res.num_turns} turns`,
          );
          if ("errors" in res) {
            for (const err of res.errors) {
              logger.error(err);
            }
          }
        }
        break;
      }
    }
  }

  return {
    run,
    getSessionId: () => sessionId,
  };
}

/**
 * Creates a focused worker agent for parallel execution.
 * No session resumption, lower maxTurns, optional conflict prevention.
 */
export function createWorkerAgent(options: {
  projectRoot: string;
  scopeDir: string;
  verbose: boolean;
  watcher?: WatcherHandle;
  dryRun?: boolean;
  workerId: number;
  claimedPaths?: Set<string>;
  agentsInstructions?: string;
  mcpServers?: McpServersMap;
}): ShadowAgent {
  const {
    projectRoot,
    scopeDir,
    verbose,
    watcher,
    dryRun = false,
    workerId,
    claimedPaths,
    agentsInstructions,
    mcpServers,
  } = options;

  let sessionId: string | undefined;
  let currentTriggerFiles: string[] = [];
  let currentAllowedEditFiles: string[] = [];

  const scopeHook = createScopeHook(
    scopeDir,
    () => currentTriggerFiles,
    () => currentAllowedEditFiles,
  );

  // Conflict prevention: deny writes to paths claimed by other workers
  const conflictHook = async (
    input: HookInput,
  ): Promise<SyncHookJSONOutput> => {
    if (!claimedPaths || claimedPaths.size === 0) return {};
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;
    if (!filePath) return {};

    const resolvedPath = resolve(filePath);
    if (claimedPaths.has(resolvedPath)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Another agent is handling ${resolvedPath}. Skip this file.`,
        },
      };
    }
    return {};
  };

  let writtenFiles = new Set<string>();

  const writeTrackingHook = async (
    input: HookInput,
  ): Promise<SyncHookJSONOutput> => {
    const postInput = input as PostToolUseHookInput;
    const toolInput = postInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (filePath) {
      logger.fileWritten(filePath);
      watcher?.addWrittenFile(filePath);
      writtenFiles.add(filePath);
    }

    return {};
  };

  async function run(
    changedFiles: string[],
    unresolvedHints?: UnresolvedHint[],
    typeHoleHints?: import("./filter").TypeHoleResult[],
  ): Promise<string[]> {
    currentTriggerFiles = changedFiles;
    currentAllowedEditFiles = (typeHoleHints ?? []).map((h) => h.file);
    writtenFiles = new Set();

    const prompt = await buildWorkerPrompt(
      changedFiles,
      projectRoot,
      unresolvedHints ?? [],
      typeHoleHints,
      workerId,
    );

    const response = query({
      prompt,
      options: {
        cwd: projectRoot,
        systemPrompt: systemPrompt(projectRoot, agentsInstructions),
        settingSources: ["project"],
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 10,
        ...(mcpServers ? { mcpServers } : {}),
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [scopeHook, conflictHook],
            },
          ],
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: dryRun ? [] : [writeTrackingHook],
            },
          ],
        },
      },
    });

    for await (const message of response) {
      handleWorkerMessage(message, workerId, verbose);
    }

    currentTriggerFiles = [];
    return dryRun ? [] : [...writtenFiles];
  }

  function handleWorkerMessage(
    message: SDKMessage,
    id: number,
    verbose: boolean,
  ) {
    switch (message.type) {
      case "system": {
        const sys = message as SDKSystemMessage;
        if (sys.subtype === "init") {
          sessionId = sys.session_id;
          if (verbose) {
            logger.verbose(`worker ${id}: session ${sessionId}`);
          }
        }
        break;
      }

      case "assistant": {
        const asst = message as SDKAssistantMessage;
        if (verbose && asst.message.content) {
          for (const block of asst.message.content) {
            if ("type" in block && block.type === "tool_use") {
              const tool = block as {
                type: "tool_use";
                name: string;
                input: Record<string, unknown>;
              };
              const filePath = tool.input?.file_path as string | undefined;
              logger.toolCall(`w${id}:${tool.name}`, filePath);
            }
          }
        }
        break;
      }

      case "result": {
        const res = message as SDKResultMessage;
        if (res.subtype === "success") {
          if (verbose) {
            logger.verbose(
              `worker ${id}: done (${(res.duration_ms / 1000).toFixed(1)}s, $${res.total_cost_usd.toFixed(4)})`,
            );
          }
        } else {
          logger.error(`worker ${id}: ${res.subtype} after ${res.num_turns} turns`);
        }
        break;
      }
    }
  }

  return {
    run,
    getSessionId: () => sessionId,
  };
}
