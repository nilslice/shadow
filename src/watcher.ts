import { watch } from "node:fs";
import { resolve } from "node:path";
import { isConfigFile } from "./project-config";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".pytest_cache",
  "target",
  ".shadow",
]);

const IGNORE_EXTENSIONS = new Set([
  ".lock",
  ".log",
  ".map",
  ".min.js",
  ".min.css",
]);

function shouldIgnore(filename: string): boolean {
  const parts = filename.split("/");
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
  }
  const ext = filename.slice(filename.lastIndexOf("."));
  if (IGNORE_EXTENSIONS.has(ext)) return true;
  return false;
}

export type WatcherHandle = {
  close(): void;
  addWrittenFile(filePath: string): void;
};

export function startWatcher(
  projectRoot: string,
  scopeDir: string,
  onChanges: (changedFiles: string[]) => void,
  debounceMs: number,
  onConfigChange?: (changedFiles: string[]) => void,
): WatcherHandle {
  const pendingChanges = new Set<string>();
  const pendingConfigChanges = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let configDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Track files the agent recently wrote to avoid feedback loops.
  // Entries expire after a short window.
  const recentlyWritten = new Map<string, number>();
  const WRITTEN_COOLDOWN_MS = 3000;

  function isRecentlyWritten(fullPath: string): boolean {
    const ts = recentlyWritten.get(fullPath);
    if (!ts) return false;
    if (Date.now() - ts > WRITTEN_COOLDOWN_MS) {
      recentlyWritten.delete(fullPath);
      return false;
    }
    return true;
  }

  const watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    if (shouldIgnore(filename)) return;

    const fullPath = resolve(projectRoot, filename);

    if (isRecentlyWritten(fullPath)) return;

    // Config files are handled separately and never sent to the agent
    if (isConfigFile(filename)) {
      if (onConfigChange) {
        pendingConfigChanges.add(fullPath);
        if (configDebounceTimer) clearTimeout(configDebounceTimer);
        configDebounceTimer = setTimeout(() => {
          const files = [...pendingConfigChanges];
          pendingConfigChanges.clear();
          if (files.length > 0) {
            onConfigChange(files);
          }
        }, debounceMs);
      }
      return;
    }

    pendingChanges.add(fullPath);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const files = [...pendingChanges];
      pendingChanges.clear();
      if (files.length > 0) {
        onChanges(files);
      }
    }, debounceMs);
  });

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (configDebounceTimer) clearTimeout(configDebounceTimer);
      watcher.close();
    },
    addWrittenFile(filePath: string) {
      recentlyWritten.set(resolve(filePath), Date.now());
    },
  };
}
