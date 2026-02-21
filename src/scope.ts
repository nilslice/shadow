import { resolve } from "node:path";
import type {
  HookCallback,
  HookInput,
  SyncHookJSONOutput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Creates a PreToolUse hook that restricts Write/Edit to within the scope boundary.
 * Blocks modifications to files that triggered the current run (user's files),
 * unless those files are in the allowed-edit list (e.g. files with type holes).
 */
export function createScopeHook(
  scopeDir: string,
  getTriggerFiles: () => string[],
  getAllowedEditFiles?: () => string[],
): HookCallback {
  const resolvedScope = resolve(scopeDir);

  return async (input: HookInput): Promise<SyncHookJSONOutput> => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (!filePath) return {};

    const resolvedPath = resolve(filePath);

    // Block writes outside the scope boundary
    if (!resolvedPath.startsWith(resolvedScope + "/") && resolvedPath !== resolvedScope) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Write blocked: ${resolvedPath} is outside the scope boundary ${resolvedScope}. Write generated files within the project.`,
        },
      };
    }

    // Block modifications to files that triggered this run,
    // unless the file is in the allowed-edit list (has type holes to fill)
    const triggerFiles = getTriggerFiles();
    const allowedEdits = getAllowedEditFiles?.() ?? [];
    if (triggerFiles.includes(resolvedPath) && !allowedEdits.includes(resolvedPath)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Write blocked: ${resolvedPath} is a user-edited file. Do not modify the user's files. Only generate new implementation files.`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Path is within scope boundary",
      },
    };
  };
}
