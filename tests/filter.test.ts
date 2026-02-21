import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findFilesWithTypeHoles, findFilesWithUnresolvedImports } from "../src/filter";

const TMP = join(import.meta.dir, ".tmp-filter");

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(TMP, name);
  mkdirSync(join(TMP, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ----- Type-hole detection -----

describe("findFilesWithTypeHoles", () => {
  test("detects TODO comments in TypeScript", async () => {
    const file = write("todo.ts", [
      "function sort(arr: number[]): number[] {",
      "  // TODO: implement quicksort",
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes).toHaveLength(1);
    expect(results[0].holes[0].pattern).toBe("TODO");
    expect(results[0].holes[0].line).toBe(2);
  });

  test("detects FIXME comments", async () => {
    const file = write("fixme.ts", [
      "export function broken() {",
      "  // FIXME: this is wrong",
      "  return null;",
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes[0].pattern).toBe("FIXME");
  });

  test("detects throw new Error('not implemented')", async () => {
    const file = write("stub.ts", [
      'export function handler() {',
      '  throw new Error("not implemented")',
      '}',
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes[0].pattern).toBe("not_implemented");
  });

  test("detects throw new Error('TODO')", async () => {
    const file = write("todo-throw.ts", [
      'export function handler() {',
      '  throw new Error("TODO")',
      '}',
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes[0].pattern).toBe("not_implemented");
  });

  test("detects Python patterns", async () => {
    const file = write("stub.py", [
      "def process(data):",
      "    # TODO: implement",
      "    raise NotImplementedError",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes).toHaveLength(2);
  });

  test("detects Rust patterns", async () => {
    const file = write("stub.rs", [
      "fn process() {",
      "    todo!()",
      "}",
      "fn other() {",
      "    unimplemented!()",
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes).toHaveLength(2);
  });

  test("detects Go patterns", async () => {
    const file = write("stub.go", [
      "func handler() {",
      '    panic("not implemented")',
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes[0].pattern).toBe("not_implemented");
  });

  test("returns empty for clean file", async () => {
    const file = write("clean.ts", [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(0);
  });

  test("skips unsupported file extensions", async () => {
    const file = write("data.json", '{"key": "value"}');
    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(0);
  });

  test("handles multiple holes in one file", async () => {
    const file = write("multi.ts", [
      "// TODO: implement sorting",
      "export function sort() {}",
      "",
      "// FIXME: edge case handling",
      "export function parse() {",
      '  throw new Error("not implemented")',
      "}",
    ].join("\n"));

    const results = await findFilesWithTypeHoles([file]);
    expect(results).toHaveLength(1);
    expect(results[0].holes).toHaveLength(3);
  });
});

// ----- Unresolved import detection -----

describe("findFilesWithUnresolvedImports", () => {
  test("detects missing relative imports in TypeScript", async () => {
    const file = write("app.ts", [
      'import { User } from "./models/user"',
      'import { Config } from "./config"',
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toContain("./models/user");
    expect(results[0].unresolved).toContain("./config");
  });

  test("ignores bare specifiers (node_modules)", async () => {
    const file = write("bare.ts", [
      'import { resolve } from "node:path"',
      'import express from "express"',
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(0);
  });

  test("resolves existing files correctly", async () => {
    write("lib/utils.ts", "export const x = 1;");
    const file = write("consumer.ts", [
      'import { x } from "./lib/utils"',
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(0);
  });

  test("detects require() calls", async () => {
    const file = write("cjs.js", [
      'const db = require("./database")',
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toContain("./database");
  });

  test("detects re-exports", async () => {
    const file = write("reexport.ts", [
      'export { Thing } from "./thing"',
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toContain("./thing");
  });

  test("detects missing Python imports", async () => {
    const file = write("main.py", [
      "from utils import helper",
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toContain("utils");
  });

  test("returns empty for files with no imports", async () => {
    const file = write("standalone.ts", [
      "const x = 1;",
      "console.log(x);",
    ].join("\n"));

    const results = await findFilesWithUnresolvedImports([file], TMP);
    expect(results).toHaveLength(0);
  });

  test("handles nonexistent files gracefully", async () => {
    const results = await findFilesWithUnresolvedImports(
      [join(TMP, "does-not-exist.ts")],
      TMP,
    );
    expect(results).toHaveLength(0);
  });
});
