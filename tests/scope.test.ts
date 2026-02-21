import { describe, test, expect } from "bun:test";
import { createScopeHook } from "../src/scope";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

function makeInput(filePath: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath },
  } as unknown as PreToolUseHookInput;
}

describe("createScopeHook", () => {
  const scopeDir = "/project/src";

  test("allows writes within scope boundary", async () => {
    const hook = createScopeHook(scopeDir, () => [], () => []);
    const result = await hook(makeInput("/project/src/utils.ts"));
    const output = result?.hookSpecificOutput as Record<string, string>;
    expect(output?.permissionDecision).toBe("allow");
  });

  test("denies writes outside scope boundary", async () => {
    const hook = createScopeHook(scopeDir, () => [], () => []);
    const result = await hook(makeInput("/other/place/file.ts"));
    const output = result?.hookSpecificOutput as Record<string, string>;
    expect(output?.permissionDecision).toBe("deny");
    expect(output?.permissionDecisionReason).toContain("outside the scope boundary");
  });

  test("denies writes to trigger files", async () => {
    const triggerFile = "/project/src/app.ts";
    const hook = createScopeHook(scopeDir, () => [triggerFile], () => []);
    const result = await hook(makeInput(triggerFile));
    const output = result?.hookSpecificOutput as Record<string, string>;
    expect(output?.permissionDecision).toBe("deny");
    expect(output?.permissionDecisionReason).toContain("user-edited file");
  });

  test("allows writes to trigger files that are in allowed-edit list", async () => {
    const file = "/project/src/app.ts";
    const hook = createScopeHook(scopeDir, () => [file], () => [file]);
    const result = await hook(makeInput(file));
    const output = result?.hookSpecificOutput as Record<string, string>;
    expect(output?.permissionDecision).toBe("allow");
  });

  test("returns empty for missing file_path", async () => {
    const hook = createScopeHook(scopeDir, () => [], () => []);
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {},
    } as unknown as PreToolUseHookInput;
    const result = await hook(input);
    expect(result).toEqual({});
  });

  test("allows writes to non-trigger files within scope", async () => {
    const hook = createScopeHook(
      scopeDir,
      () => ["/project/src/app.ts"],
      () => [],
    );
    const result = await hook(makeInput("/project/src/generated/types.ts"));
    const output = result?.hookSpecificOutput as Record<string, string>;
    expect(output?.permissionDecision).toBe("allow");
  });
});
