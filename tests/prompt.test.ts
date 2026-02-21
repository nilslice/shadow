import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt, buildPrompt, buildWorkerPrompt } from "../src/prompt";

const TMP = join(import.meta.dir, ".tmp-prompt");

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(TMP, name);
  const dir = path.substring(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("systemPrompt", () => {
  test("includes project root", () => {
    const prompt = systemPrompt("/my/project");
    expect(prompt).toContain("/my/project");
  });

  test("includes shadow identity", () => {
    const prompt = systemPrompt("/project");
    expect(prompt).toContain("You are shadow");
  });

  test("includes type-hole filling instructions", () => {
    const prompt = systemPrompt("/project");
    expect(prompt).toContain("type holes");
  });
});

describe("buildPrompt", () => {
  test("includes file contents", async () => {
    const file = write("example.ts", 'export const x = "hello";');
    const prompt = await buildPrompt([file], TMP);
    expect(prompt).toContain('export const x = "hello"');
  });

  test("includes relative path", async () => {
    const file = write("src/app.ts", "const y = 1;");
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(file, "const y = 1;");
    const prompt = await buildPrompt([file], TMP);
    expect(prompt).toContain("src/app.ts");
  });

  test("includes unresolved hints", async () => {
    const file = write("hints.ts", "import { Foo } from './foo'");
    const prompt = await buildPrompt([file], TMP, [
      { file, unresolved: ["./foo", "./bar"] },
    ]);
    expect(prompt).toContain("Unresolved imports detected");
    expect(prompt).toContain("./foo, ./bar");
  });

  test("includes type-hole hints", async () => {
    const file = write("holes.ts", "// TODO: implement");
    const prompt = await buildPrompt([file], TMP, undefined, [
      {
        file,
        holes: [{ line: 1, pattern: "TODO", context: "// TODO: implement" }],
      },
    ]);
    expect(prompt).toContain("Type holes detected");
    expect(prompt).toContain("TODO");
  });

  test("generates correct action when only imports are unresolved", async () => {
    const file = write("imports-only.ts", "import { X } from './x'");
    const prompt = await buildPrompt(
      [file],
      TMP,
      [{ file, unresolved: ["./x"] }],
      [],
    );
    expect(prompt).toContain("Generate implementations for the unresolved imports");
  });

  test("generates correct action when only type holes exist", async () => {
    const file = write("holes-only.ts", "// TODO: do something");
    const prompt = await buildPrompt([file], TMP, [], [
      {
        file,
        holes: [{ line: 1, pattern: "TODO", context: "// TODO: do something" }],
      },
    ]);
    expect(prompt).toContain("Fill in the type holes");
  });

  test("handles unreadable files gracefully", async () => {
    const prompt = await buildPrompt(
      [join(TMP, "nonexistent.ts")],
      TMP,
    );
    expect(prompt).toContain("could not read");
  });
});

describe("buildWorkerPrompt", () => {
  test("includes worker ID", async () => {
    const file = write("worker.ts", "const z = 1;");
    const prompt = await buildWorkerPrompt(
      [file],
      TMP,
      [{ file, unresolved: ["./missing"] }],
      [],
      3,
    );
    expect(prompt).toContain("worker agent #3");
  });

  test("includes assigned unresolved hints", async () => {
    const file = write("worker-hints.ts", "import { A } from './a'");
    const prompt = await buildWorkerPrompt(
      [file],
      TMP,
      [{ file, unresolved: ["./a"] }],
    );
    expect(prompt).toContain("Unresolved imports to generate");
    expect(prompt).toContain("./a");
  });

  test("includes scope restriction", async () => {
    const file = write("worker-scope.ts", "const w = 1;");
    const prompt = await buildWorkerPrompt(
      [file],
      TMP,
      [{ file, unresolved: ["./x"] }],
    );
    expect(prompt).toContain("Do not work on files not assigned to you");
  });
});
