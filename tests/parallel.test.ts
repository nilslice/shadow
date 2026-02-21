import { describe, test, expect } from "bun:test";
import { partitionWork } from "../src/parallel";
import type { TypeHoleResult } from "../src/filter";

function hint(file: string, unresolved: string[]) {
  return { file, unresolved };
}

function hole(file: string, line: number): TypeHoleResult {
  return {
    file,
    holes: [{ line, pattern: "TODO", context: "// TODO" }],
  };
}

describe("partitionWork", () => {
  test("returns single group for small workloads (<=2 hints)", () => {
    const changed = ["/project/src/app.ts"];
    const hints = [hint("/project/src/app.ts", ["./utils"])];
    const holes: TypeHoleResult[] = [];

    const groups = partitionWork(changed, hints, holes, 4);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(0);
    expect(groups[0].changedFiles).toEqual(changed);
    expect(groups[0].unresolvedHints).toEqual(hints);
  });

  test("returns single group for exactly 2 hints", () => {
    const changed = ["/project/src/a.ts", "/project/src/b.ts"];
    const hints = [
      hint("/project/src/a.ts", ["./x"]),
      hint("/project/src/b.ts", ["./y"]),
    ];

    const groups = partitionWork(changed, hints, [], 4);

    expect(groups).toHaveLength(1);
  });

  test("groups by source file directory", () => {
    const changed = ["/project/src/a.ts", "/project/lib/b.ts", "/project/lib/c.ts"];
    const hints = [
      hint("/project/src/a.ts", ["./x"]),
      hint("/project/lib/b.ts", ["./y"]),
      hint("/project/lib/c.ts", ["./z"]),
    ];

    const groups = partitionWork(changed, hints, [], 4);

    expect(groups).toHaveLength(2);

    const srcGroup = groups.find((g) =>
      g.unresolvedHints.some((h) => h.file === "/project/src/a.ts"),
    );
    const libGroup = groups.find((g) =>
      g.unresolvedHints.some((h) => h.file === "/project/lib/b.ts"),
    );

    expect(srcGroup).toBeDefined();
    expect(libGroup).toBeDefined();
    expect(libGroup!.unresolvedHints).toHaveLength(2);
  });

  test("caps at maxGroups and merges overflow", () => {
    const hints = [
      hint("/project/a/file.ts", ["./x"]),
      hint("/project/b/file.ts", ["./y"]),
      hint("/project/c/file.ts", ["./z"]),
    ];

    const groups = partitionWork(
      hints.map((h) => h.file),
      hints,
      [],
      2,
    );

    expect(groups).toHaveLength(2);
    // Last group should have the overflow merged in
    const totalHints = groups.reduce(
      (sum, g) => sum + g.unresolvedHints.length,
      0,
    );
    expect(totalHints).toBe(3);
  });

  test("returns single group when all files are in the same directory", () => {
    const hints = [
      hint("/project/src/a.ts", ["./x"]),
      hint("/project/src/b.ts", ["./y"]),
      hint("/project/src/c.ts", ["./z"]),
    ];

    const groups = partitionWork(
      hints.map((h) => h.file),
      hints,
      [],
      4,
    );

    // Single directory means single group, so no parallelization
    expect(groups).toHaveLength(1);
  });

  test("includes type holes in partitioning", () => {
    const hints = [hint("/project/src/a.ts", ["./x"])];
    const holes = [
      hole("/project/lib/b.ts", 5),
      hole("/project/lib/c.ts", 10),
    ];

    const groups = partitionWork(
      ["/project/src/a.ts", "/project/lib/b.ts", "/project/lib/c.ts"],
      hints,
      holes,
      4,
    );

    expect(groups).toHaveLength(2);
    const totalHoles = groups.reduce(
      (sum, g) => sum + g.typeHoleHints.length,
      0,
    );
    expect(totalHoles).toBe(2);
  });

  test("assigns sequential IDs to groups", () => {
    const hints = [
      hint("/project/a/file.ts", ["./x"]),
      hint("/project/b/file.ts", ["./y"]),
      hint("/project/c/file.ts", ["./z"]),
    ];

    const groups = partitionWork(
      hints.map((h) => h.file),
      hints,
      [],
      5,
    );

    for (let i = 0; i < groups.length; i++) {
      expect(groups[i].id).toBe(i);
    }
  });
});
