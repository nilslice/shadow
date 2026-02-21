#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLATFORMS = {
  "darwin-arm64": "@nilslice/shadow-darwin-arm64",
  "darwin-x64": "@nilslice/shadow-darwin-x64",
  "linux-arm64": "@nilslice/shadow-linux-arm64",
  "linux-x64": "@nilslice/shadow-linux-x64",
  "win32-x64": "@nilslice/shadow-windows-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PLATFORMS[key];

if (!pkg) {
  console.error(
    `shadow: unsupported platform ${process.platform}-${process.arch}\n` +
      `Supported: ${Object.keys(PLATFORMS).join(", ")}`,
  );
  process.exit(1);
}

let binPath;
try {
  const require = createRequire(import.meta.url);
  const ext = process.platform === "win32" ? ".exe" : "";
  binPath = require.resolve(`${pkg}/bin/shadow${ext}`);
} catch {
  console.error(
    `shadow: could not find package "${pkg}"\n` +
      `Try reinstalling with: npm install @nilslice/shadow`,
  );
  process.exit(1);
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  if (err && typeof err === "object" && "status" in err) {
    process.exit(err.status ?? 1);
  }
  throw err;
}
