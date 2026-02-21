import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/**
 * Language-specific import patterns and resolution rules.
 * Each pattern extracts the import path from a source line.
 */
const IMPORT_PATTERNS: {
  extensions: string[];
  patterns: RegExp[];
  resolve: (importPath: string, sourceFile: string, projectRoot: string) => string[];
}[] = [
  {
    // TypeScript / JavaScript
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"],
    patterns: [
      /import\s+.*?from\s+["']([^"']+)["']/,
      /import\s+["']([^"']+)["']/,
      /require\s*\(\s*["']([^"']+)["']\s*\)/,
      /export\s+.*?from\s+["']([^"']+)["']/,
    ],
    resolve(importPath: string, sourceFile: string, projectRoot: string): string[] {
      // Skip bare specifiers (node_modules packages)
      if (!importPath.startsWith(".") && !importPath.startsWith("/")) return [];

      const dir = dirname(sourceFile);
      const base = importPath.startsWith("/")
        ? resolve(projectRoot, importPath.slice(1))
        : resolve(dir, importPath);

      // Try common extensions and index files
      return [
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + ".jsx",
        base + ".mts",
        base + ".mjs",
        join(base, "index.ts"),
        join(base, "index.tsx"),
        join(base, "index.js"),
        join(base, "index.jsx"),
      ];
    },
  },
  {
    // Python
    extensions: [".py"],
    patterns: [
      /from\s+(\S+)\s+import/,
      /import\s+(\S+)/,
    ],
    resolve(importPath: string, sourceFile: string, projectRoot: string): string[] {
      const dir = dirname(sourceFile);
      const parts = importPath.split(".");

      // Relative import (starts with .)
      if (importPath.startsWith(".")) {
        const relParts = parts.filter((p) => p !== "");
        const modulePath = resolve(dir, ...relParts);
        return [modulePath + ".py", join(modulePath, "__init__.py")];
      }

      // Absolute import - check from project root
      const modulePath = resolve(projectRoot, ...parts);
      return [modulePath + ".py", join(modulePath, "__init__.py")];
    },
  },
  {
    // Go
    extensions: [".go"],
    patterns: [
      /import\s+"([^"]+)"/,
      /\t"([^"]+)"/,  // inside import block
    ],
    resolve(importPath: string, sourceFile: string, projectRoot: string): string[] {
      // Skip standard library and external packages
      if (!importPath.includes("/") || importPath.includes(".")) {
        // Could be a local package - check if directory exists
        const pkgDir = resolve(projectRoot, importPath.split("/").pop() || "");
        return [pkgDir];
      }
      return [];
    },
  },
  {
    // Rust
    extensions: [".rs"],
    patterns: [
      /use\s+crate::(\S+)/,
      /mod\s+(\w+)\s*;/,
    ],
    resolve(importPath: string, sourceFile: string, projectRoot: string): string[] {
      const parts = importPath.split("::");
      const moduleName = parts[0];
      const srcDir = resolve(projectRoot, "src");
      return [
        resolve(srcDir, moduleName + ".rs"),
        resolve(srcDir, moduleName, "mod.rs"),
      ];
    },
  },
];

// ----- Type-hole detection -----

export type TypeHole = {
  line: number;
  pattern: string;
  context: string;
};

export type TypeHoleResult = {
  file: string;
  holes: TypeHole[];
};

const HOLE_PATTERNS: {
  extensions: string[];
  patterns: { regex: RegExp; name: string }[];
}[] = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"],
    patterns: [
      { regex: /\/\/\s*TODO\b(.*)/, name: "TODO" },
      { regex: /\/\/\s*FIXME\b(.*)/, name: "FIXME" },
      { regex: /throw\s+new\s+Error\s*\(\s*["']not implemented["']\s*\)/, name: "not_implemented" },
      { regex: /throw\s+new\s+Error\s*\(\s*["']TODO["']\s*\)/, name: "not_implemented" },
    ],
  },
  {
    extensions: [".py"],
    patterns: [
      { regex: /#\s*TODO\b(.*)/, name: "TODO" },
      { regex: /raise\s+NotImplementedError/, name: "not_implemented" },
      { regex: /pass\s*#\s*TODO/, name: "not_implemented" },
    ],
  },
  {
    extensions: [".go"],
    patterns: [
      { regex: /\/\/\s*TODO\b(.*)/, name: "TODO" },
      { regex: /panic\s*\(\s*["']not implemented["']\s*\)/, name: "not_implemented" },
    ],
  },
  {
    extensions: [".rs"],
    patterns: [
      { regex: /\/\/\s*TODO\b(.*)/, name: "TODO" },
      { regex: /todo!\s*\(/, name: "not_implemented" },
      { regex: /unimplemented!\s*\(/, name: "not_implemented" },
    ],
  },
];

/**
 * Check if any changed files contain type holes (TODO, not-implemented stubs, etc.)
 */
export async function findFilesWithTypeHoles(
  changedFiles: string[],
): Promise<TypeHoleResult[]> {
  const results: TypeHoleResult[] = [];

  for (const filePath of changedFiles) {
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const langConfig = HOLE_PATTERNS.find((lang) =>
      lang.extensions.includes(ext),
    );
    if (!langConfig) continue;

    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const holes: TypeHole[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      for (const { regex, name } of langConfig.patterns) {
        if (regex.test(lines[i])) {
          holes.push({
            line: i + 1,
            pattern: name,
            context: lines[i].trim(),
          });
        }
      }
    }

    if (holes.length > 0) {
      results.push({ file: filePath, holes });
    }
  }

  return results;
}

// ----- Unresolved import detection -----

/**
 * Check if any changed files have imports that point to non-existent files.
 * Returns the list of files that have unresolved imports, or empty if all resolve.
 */
export async function findFilesWithUnresolvedImports(
  changedFiles: string[],
  projectRoot: string,
): Promise<{ file: string; unresolved: string[] }[]> {
  const results: { file: string; unresolved: string[] }[] = [];

  for (const filePath of changedFiles) {
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const langConfig = IMPORT_PATTERNS.find((lang) =>
      lang.extensions.includes(ext),
    );
    if (!langConfig) continue;

    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const unresolved: string[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      for (const pattern of langConfig.patterns) {
        const match = line.match(pattern);
        if (!match || !match[1]) continue;

        const importPath = match[1];
        const candidates = langConfig.resolve(importPath, filePath, projectRoot);

        if (candidates.length === 0) continue;

        const exists = candidates.some((c) => existsSync(c));
        if (!exists) {
          unresolved.push(importPath);
        }
      }
    }

    if (unresolved.length > 0) {
      results.push({ file: filePath, unresolved });
    }
  }

  return results;
}
