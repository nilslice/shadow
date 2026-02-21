import { relative } from "node:path";
import type { TypeHoleResult } from "./filter";

const MAX_FILE_LINES = 500;

export function systemPrompt(projectRoot: string, projectInstructions?: string): string {
  let prompt = `You are shadow, an AI agent that watches a developer's project and automatically generates missing implementations.

When triggered with changed files, you must:

1. Read the changed files provided below to understand what the developer is working on.
2. Use Glob and Grep to explore the project structure and understand existing patterns, the language, the build system, and the module/import conventions in use.
3. Identify any unresolved symbols - types, functions, classes, modules, packages - that the code references but which do not exist yet in the project.
4. For each missing symbol, generate a reasonable implementation and write it to the path the code expects. For example:
   - \`import { User } from "./types/User"\` means create \`./types/User.ts\` with a User export
   - \`from client import get\` means create \`client/__init__.py\` with a get function
   - \`use crate::config;\` means create \`src/config.rs\` with the referenced items
5. Do NOT modify the user's source files. Only create or update generated implementation files.
6. Match the project's existing patterns, naming conventions, language, and coding style.
7. If a previously generated file needs updating based on new changes, edit it.
8. Keep implementations minimal but functional - they should satisfy the type checker and provide reasonable default runtime behavior.
9. If you are unsure about intent, prefer generating a type/interface stub over a full implementation.
10. When type holes are detected (TODO comments, throw new Error("not implemented"), empty stubs), fill in reasonable implementations. You ARE allowed to edit the user's file for these specific holes. Only modify the marked sections - do not restructure or rewrite other parts of the file.

Project root: ${projectRoot}`;

  if (projectInstructions) {
    prompt += `\n\n# Project Instructions\n\n${projectInstructions}`;
  }

  return prompt;
}

// Track previous file contents for diffing
const fileCache = new Map<string, string>();

export async function buildPrompt(
  changedFiles: string[],
  projectRoot: string,
  unresolvedHints?: { file: string; unresolved: string[] }[],
  typeHoleHints?: TypeHoleResult[],
): Promise<string> {
  const sections: string[] = [];
  sections.push("The following files were just saved:\n");

  for (const filePath of changedFiles) {
    const relPath = relative(projectRoot, filePath);
    try {
      const content = await Bun.file(filePath).text();
      const previous = fileCache.get(filePath);
      fileCache.set(filePath, content);

      const lines = content.split("\n");

      if (previous && lines.length > 50) {
        // For large files that we've seen before, send only the diff
        const diff = simpleDiff(previous, content);
        if (diff) {
          sections.push(`--- ${relPath} (diff) ---\n${diff}\n`);
          continue;
        }
      }

      if (lines.length > MAX_FILE_LINES) {
        const truncated = lines.slice(0, MAX_FILE_LINES).join("\n");
        sections.push(
          `--- ${relPath} (truncated at ${MAX_FILE_LINES} lines, ${lines.length} total) ---\n${truncated}\n`,
        );
      } else {
        sections.push(`--- ${relPath} ---\n${content}\n`);
      }
    } catch {
      sections.push(`--- ${relPath} (could not read) ---\n`);
    }
  }

  // Include pre-filter hints so the agent knows exactly what's missing
  if (unresolvedHints && unresolvedHints.length > 0) {
    sections.push("Unresolved imports detected:\n");
    for (const { file, unresolved } of unresolvedHints) {
      const relPath = relative(projectRoot, file);
      sections.push(`  ${relPath}: ${unresolved.join(", ")}`);
    }
    sections.push("");
  }

  // Include type-hole hints
  if (typeHoleHints && typeHoleHints.length > 0) {
    sections.push("Type holes detected (implement these stubs):\n");
    for (const { file, holes } of typeHoleHints) {
      const relPath = relative(projectRoot, file);
      for (const hole of holes) {
        sections.push(`  ${relPath}:${hole.line} [${hole.pattern}] ${hole.context}`);
      }
    }
    sections.push("");
  }

  const hasImports = unresolvedHints && unresolvedHints.length > 0;
  const hasHoles = typeHoleHints && typeHoleHints.length > 0;

  if (hasImports && hasHoles) {
    sections.push(
      "Generate implementations for the unresolved imports and fill in the type holes listed above.",
    );
  } else if (hasHoles) {
    sections.push(
      "Fill in the type holes listed above with reasonable implementations.",
    );
  } else {
    sections.push(
      "Generate implementations for the unresolved imports above, writing files at the paths the code expects them.",
    );
  }

  return sections.join("\n");
}

/**
 * Build a focused prompt for a parallel worker agent.
 * Similar to buildPrompt but scoped to a subset of work.
 */
export async function buildWorkerPrompt(
  changedFiles: string[],
  projectRoot: string,
  unresolvedHints: { file: string; unresolved: string[] }[],
  typeHoleHints?: TypeHoleResult[],
  workerId?: number,
): Promise<string> {
  const sections: string[] = [];

  if (workerId !== undefined) {
    sections.push(
      `You are worker agent #${workerId}. Focus ONLY on the specific files and imports assigned to you below.\n`,
    );
  }

  sections.push("The following files were just saved:\n");

  for (const filePath of changedFiles) {
    const relPath = relative(projectRoot, filePath);
    try {
      const content = await Bun.file(filePath).text();
      const lines = content.split("\n");

      if (lines.length > MAX_FILE_LINES) {
        const truncated = lines.slice(0, MAX_FILE_LINES).join("\n");
        sections.push(
          `--- ${relPath} (truncated at ${MAX_FILE_LINES} lines, ${lines.length} total) ---\n${truncated}\n`,
        );
      } else {
        sections.push(`--- ${relPath} ---\n${content}\n`);
      }
    } catch {
      sections.push(`--- ${relPath} (could not read) ---\n`);
    }
  }

  if (unresolvedHints.length > 0) {
    sections.push("Unresolved imports to generate:\n");
    for (const { file, unresolved } of unresolvedHints) {
      const relPath = relative(projectRoot, file);
      sections.push(`  ${relPath}: ${unresolved.join(", ")}`);
    }
    sections.push("");
  }

  if (typeHoleHints && typeHoleHints.length > 0) {
    sections.push("Type holes to fill:\n");
    for (const { file, holes } of typeHoleHints) {
      const relPath = relative(projectRoot, file);
      for (const hole of holes) {
        sections.push(`  ${relPath}:${hole.line} [${hole.pattern}] ${hole.context}`);
      }
    }
    sections.push("");
  }

  sections.push(
    "Generate implementations for the items listed above. Do not work on files not assigned to you.",
  );

  return sections.join("\n");
}

/**
 * Produce a minimal unified-style diff between two strings.
 * Returns null if the files are identical.
 */
function simpleDiff(oldText: string, newText: string): string | null {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const chunks: string[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference - emit context + change
    const contextStart = Math.max(0, j - 2);
    for (let c = contextStart; c < j; c++) {
      chunks.push(` ${newLines[c]}`);
    }

    // Consume differing lines
    while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
      chunks.push(`-${oldLines[i]}`);
      i++;
    }
    while (j < newLines.length && (i >= oldLines.length || newLines[j] !== oldLines[i])) {
      chunks.push(`+${newLines[j]}`);
      j++;
    }

    // Trailing context
    const contextEnd = Math.min(newLines.length, j + 2);
    for (let c = j; c < contextEnd; c++) {
      chunks.push(` ${newLines[c]}`);
    }
    i = Math.max(i, contextEnd - 2 + (i - j));
    j = contextEnd;
  }

  return chunks.length > 0 ? chunks.join("\n") : null;
}
