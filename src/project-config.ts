import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProjectConfig = {
  projectInstructions: string;
  mcpServers: Record<string, unknown>;
};

/**
 * Files (relative to project root) that are agent configuration.
 * Changes to these files trigger a config reload instead of agent analysis.
 */
export const CONFIG_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".mcp.json",
  "claude_mcp_config.json",
  ".claude/mcp.json",
];

/**
 * Directories (relative to project root) that contain agent configuration.
 * Any file inside these directories is treated as config, not source code.
 */
export const CONFIG_DIRS = [".agents", "SKILLS"];

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const instructionParts: string[] = [];

  // Load CLAUDE.md
  const claudeMd = join(projectRoot, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8").trim();
    if (content) instructionParts.push(`## CLAUDE.md\n\n${content}`);
  }

  // Load AGENTS.md
  const agentsMd = join(projectRoot, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, "utf-8").trim();
    if (content) instructionParts.push(`## AGENTS.md\n\n${content}`);
  }

  // Load .agents/ directory files
  const agentsDir = join(projectRoot, ".agents");
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir).sort();
    for (const file of files) {
      const filePath = join(agentsDir, file);
      if (statSync(filePath).isFile()) {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content) instructionParts.push(`## .agents/${file}\n\n${content}`);
      }
    }
  }

  // Load SKILLS/ directory files
  const skillsDir = join(projectRoot, "SKILLS");
  if (existsSync(skillsDir)) {
    const files = readdirSync(skillsDir).sort();
    for (const file of files) {
      const filePath = join(skillsDir, file);
      if (statSync(filePath).isFile()) {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content) instructionParts.push(`## SKILLS/${file}\n\n${content}`);
      }
    }
  }

  // Load MCP config — try candidates in order
  const mcpCandidates = [
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".claude", "mcp.json"),
    join(projectRoot, "claude_mcp_config.json"),
  ];

  let mcpServers: Record<string, unknown> = {};
  for (const candidate of mcpCandidates) {
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf-8"));
        // Support both flat { server: {...} } and Claude Desktop { mcpServers: { server: {...} } }
        mcpServers = (raw.mcpServers ?? raw) as Record<string, unknown>;
        break;
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    projectInstructions: instructionParts.join("\n\n"),
    mcpServers,
  };
}
