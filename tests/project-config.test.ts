import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, isConfigFile, CONFIG_FILES, CONFIG_DIRS } from "../src/project-config";

const TMP = join(import.meta.dir, ".tmp-project-config");

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string) {
  const fullPath = join(TMP, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

describe("isConfigFile", () => {
  test("returns true for CLAUDE.md", () => {
    expect(isConfigFile("CLAUDE.md")).toBe(true);
  });

  test("returns true for AGENTS.md", () => {
    expect(isConfigFile("AGENTS.md")).toBe(true);
  });

  test("returns true for .mcp.json", () => {
    expect(isConfigFile(".mcp.json")).toBe(true);
  });

  test("returns true for claude_mcp_config.json", () => {
    expect(isConfigFile("claude_mcp_config.json")).toBe(true);
  });

  test("returns true for .claude/mcp.json", () => {
    expect(isConfigFile(".claude/mcp.json")).toBe(true);
  });

  test("returns true for files inside .agents/", () => {
    expect(isConfigFile(".agents/my-agent.md")).toBe(true);
  });

  test("returns true for files inside SKILLS/", () => {
    expect(isConfigFile("SKILLS/my-skill.md")).toBe(true);
  });

  test("returns false for regular source files", () => {
    expect(isConfigFile("src/index.ts")).toBe(false);
    expect(isConfigFile("README.md")).toBe(false);
    expect(isConfigFile("package.json")).toBe(false);
  });
});

describe("loadProjectConfig", () => {
  test("returns empty config when no config files exist", async () => {
    const emptyDir = join(TMP, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const config = await loadProjectConfig(emptyDir);
    expect(config.projectInstructions).toBeUndefined();
    expect(config.mcpServers).toBeUndefined();
  });

  test("loads CLAUDE.md as project instructions", async () => {
    const dir = join(TMP, "claude-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "Use TypeScript strictly.");
    const config = await loadProjectConfig(dir);
    expect(config.projectInstructions).toContain("Use TypeScript strictly.");
  });

  test("loads AGENTS.md as project instructions", async () => {
    const dir = join(TMP, "agents-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "Always add tests.");
    const config = await loadProjectConfig(dir);
    expect(config.projectInstructions).toContain("Always add tests.");
  });

  test("concatenates CLAUDE.md and AGENTS.md", async () => {
    const dir = join(TMP, "both-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "Use TypeScript.");
    writeFileSync(join(dir, "AGENTS.md"), "Add tests.");
    const config = await loadProjectConfig(dir);
    expect(config.projectInstructions).toContain("Use TypeScript.");
    expect(config.projectInstructions).toContain("Add tests.");
  });

  test("loads files from .agents/ directory", async () => {
    const dir = join(TMP, "agents-dir");
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(join(dir, ".agents", "my-agent.md"), "I am an agent.");
    const config = await loadProjectConfig(dir);
    expect(config.projectInstructions).toContain("I am an agent.");
  });

  test("loads files from SKILLS/ directory", async () => {
    const dir = join(TMP, "skills-dir");
    mkdirSync(join(dir, "SKILLS"), { recursive: true });
    writeFileSync(join(dir, "SKILLS", "my-skill.md"), "I am a skill.");
    const config = await loadProjectConfig(dir);
    expect(config.projectInstructions).toContain("I am a skill.");
  });

  test("loads MCP servers from .mcp.json (flat format)", async () => {
    const dir = join(TMP, "mcp-flat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        myServer: { command: "npx", args: ["-y", "@my/server"] },
      }),
    );
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers!.myServer).toBeDefined();
    expect(config.mcpServers!.myServer.command).toBe("npx");
  });

  test("loads MCP servers from .mcp.json (mcpServers format)", async () => {
    const dir = join(TMP, "mcp-nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myServer: { command: "node", args: ["server.js"] },
        },
      }),
    );
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers!.myServer.command).toBe("node");
  });

  test("loads MCP servers from .claude/mcp.json when .mcp.json is absent", async () => {
    const dir = join(TMP, "mcp-claude-dir");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "mcp.json"),
      JSON.stringify({ fallbackServer: { command: "python", args: ["-m", "server"] } }),
    );
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers!.fallbackServer.command).toBe("python");
  });

  test("loads MCP servers from claude_mcp_config.json as last fallback", async () => {
    const dir = join(TMP, "mcp-fallback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "claude_mcp_config.json"),
      JSON.stringify({ lastServer: { command: "bun", args: ["run", "server.ts"] } }),
    );
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers!.lastServer.command).toBe("bun");
  });

  test("prefers .mcp.json over .claude/mcp.json", async () => {
    const dir = join(TMP, "mcp-priority");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ primary: { command: "primary" } }),
    );
    writeFileSync(
      join(dir, ".claude", "mcp.json"),
      JSON.stringify({ secondary: { command: "secondary" } }),
    );
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers!.primary).toBeDefined();
    expect(config.mcpServers!.secondary).toBeUndefined();
  });

  test("gracefully ignores invalid JSON in MCP config", async () => {
    const dir = join(TMP, "mcp-invalid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), "not valid json {{{");
    const config = await loadProjectConfig(dir);
    expect(config.mcpServers).toBeUndefined();
  });
});

describe("CONFIG_FILES and CONFIG_DIRS constants", () => {
  test("CONFIG_FILES includes expected paths", () => {
    expect(CONFIG_FILES).toContain("CLAUDE.md");
    expect(CONFIG_FILES).toContain("AGENTS.md");
    expect(CONFIG_FILES).toContain(".mcp.json");
    expect(CONFIG_FILES).toContain(".claude/mcp.json");
    expect(CONFIG_FILES).toContain("claude_mcp_config.json");
  });

  test("CONFIG_DIRS includes expected directories", () => {
    expect(CONFIG_DIRS).toContain(".agents");
    expect(CONFIG_DIRS).toContain("SKILLS");
  });
});
