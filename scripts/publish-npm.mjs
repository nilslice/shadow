#!/usr/bin/env node

/**
 * Prepares and publishes npm packages from CI artifacts.
 *
 * Expected layout:
 *   artifacts/shadow-{platform}-{arch}/shadow-{platform}-{arch}[.exe]
 *
 * Publishes:
 *   1. Each platform package (shadow-darwin-arm64, etc.)
 *   2. The main wrapper package (shadow)
 */

import { execSync } from "node:child_process";
import { cpSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ARTIFACTS = resolve(ROOT, "artifacts");

// Derive version from git tag (refs/tags/v1.2.3 → 1.2.3)
const ref = process.env.GITHUB_REF || "";
const version = ref.replace("refs/tags/v", "") || "0.0.0-dev";

console.log(`Publishing version ${version}\n`);

const PLATFORMS = [
  { artifact: "shadow-darwin-arm64", dir: "darwin-arm64", bin: "shadow" },
  { artifact: "shadow-darwin-x64", dir: "darwin-x64", bin: "shadow" },
  { artifact: "shadow-linux-arm64", dir: "linux-arm64", bin: "shadow" },
  { artifact: "shadow-linux-x64", dir: "linux-x64", bin: "shadow" },
  { artifact: "shadow-windows-x64", dir: "windows-x64", bin: "shadow.exe" },
];

// 1. Publish platform packages
for (const { artifact, dir, bin } of PLATFORMS) {
  const pkgDir = join(ROOT, "npm", dir);
  const binDir = join(pkgDir, "bin");
  mkdirSync(binDir, { recursive: true });

  // Copy binary from artifacts
  const src = join(ARTIFACTS, artifact, bin === "shadow.exe" ? `${artifact}.exe` : artifact);
  const dest = join(binDir, bin);
  cpSync(src, dest);
  chmodSync(dest, 0o755);

  // Update version in package.json
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  pkgJson.version = version;
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  console.log(`Publishing ${pkgJson.name}@${version}...`);
  execSync("npm publish --access public --provenance", { cwd: pkgDir, stdio: "inherit" });
}

// 2. Publish main wrapper package
const wrapperDir = join(ROOT, "npm", "shadow");
const wrapperPkg = JSON.parse(readFileSync(join(wrapperDir, "package.json"), "utf-8"));
wrapperPkg.version = version;

// Update optionalDependencies versions to match
for (const key of Object.keys(wrapperPkg.optionalDependencies || {})) {
  wrapperPkg.optionalDependencies[key] = version;
}

writeFileSync(join(wrapperDir, "package.json"), JSON.stringify(wrapperPkg, null, 2) + "\n");

console.log(`\nPublishing ${wrapperPkg.name}@${version}...`);
execSync("npm publish --access public --provenance", { cwd: wrapperDir, stdio: "inherit" });

console.log("\nAll packages published.");
