import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type ProjectConfig = {
  projectInstructions: string | undefined;
  mcpServers: Record<string, McpServerConfig> | undefined;
};

/** Flat config files recognized as agent configuration */
export const CONFIG_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".mcp.json",
  "claude_mcp_config.json",
  ".claude/mcp.json",
];

/** Directories whose contents are recognized as agent configuration */
export const CONFIG_DIRS = [".agents", "SKILLS"];

export const CONFIG_FILE_SET = new Set(CONFIG_FILES);
export const CONFIG_DIR_SET = new Set(CONFIG_DIRS);

/**
 * Returns true if the given relative filename is an agent configuration file
 * that should be excluded from analysis and trigger a live config reload instead.
 */
export function isConfigFile(filename: string): boolean {
  if (CONFIG_FILE_SET.has(filename)) return true;
  for (const dir of CONFIG_DIR_SET) {
    if (filename === dir || filename.startsWith(dir + "/")) return true;
  }
  return false;
}

/**
 * Loads project-level agent configuration from the project root.
 * Reads CLAUDE.md, AGENTS.md, .agents/, SKILLS/, and MCP config files.
 */
export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const instructionParts: string[] = [];

  // CLAUDE.md — project instructions for Claude
  const claudeMd = join(projectRoot, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      instructionParts.push(readFileSync(claudeMd, "utf-8").trim());
    } catch {
      // ignore read errors
    }
  }

  // AGENTS.md — agent-specific instructions
  const agentsMd = join(projectRoot, "AGENTS.md");
  if (existsSync(agentsMd)) {
    try {
      instructionParts.push(readFileSync(agentsMd, "utf-8").trim());
    } catch {
      // ignore read errors
    }
  }

  // .agents/ directory — each file is an agent definition
  const agentsDir = join(projectRoot, ".agents");
  if (existsSync(agentsDir)) {
    try {
      const files = readdirSync(agentsDir).sort();
      for (const file of files) {
        const filePath = join(agentsDir, file);
        instructionParts.push(readFileSync(filePath, "utf-8").trim());
      }
    } catch {
      // ignore read errors
    }
  }

  // SKILLS/ directory — each file is a skill definition
  const skillsDir = join(projectRoot, "SKILLS");
  if (existsSync(skillsDir)) {
    try {
      const files = readdirSync(skillsDir).sort();
      for (const file of files) {
        const filePath = join(skillsDir, file);
        instructionParts.push(readFileSync(filePath, "utf-8").trim());
      }
    } catch {
      // ignore read errors
    }
  }

  const projectInstructions =
    instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined;

  // MCP config — try each location in priority order
  let mcpServers: Record<string, McpServerConfig> | undefined;
  const mcpPaths = [
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".claude", "mcp.json"),
    join(projectRoot, "claude_mcp_config.json"),
  ];

  for (const mcpPath of mcpPaths) {
    if (existsSync(mcpPath)) {
      try {
        const raw = JSON.parse(readFileSync(mcpPath, "utf-8"));
        // Support both flat { "server": {...} } and Claude Desktop { "mcpServers": { "server": {...} } }
        mcpServers = raw.mcpServers ?? raw;
        break;
      } catch {
        // ignore parse errors
      }
    }
  }

  return { projectInstructions, mcpServers };
}
