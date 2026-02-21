import type { UnresolvedHint } from "./agent";
import type { TypeHoleResult } from "./filter";

export type WorkGroup = {
  id: number;
  changedFiles: string[];
  unresolvedHints: UnresolvedHint[];
  typeHoleHints: TypeHoleResult[];
};

/**
 * Partition unresolved hints into independent groups for parallel processing.
 * Groups by source file directory - hints in the same directory are likely related.
 * Returns a single group if the work is too small to benefit from parallelism.
 */
export function partitionWork(
  changedFiles: string[],
  unresolvedHints: UnresolvedHint[],
  typeHoleHints: TypeHoleResult[],
  maxGroups: number,
): WorkGroup[] {
  // Don't parallelize small amounts of work
  if (unresolvedHints.length + typeHoleHints.length <= 2) {
    return [
      {
        id: 0,
        changedFiles,
        unresolvedHints,
        typeHoleHints,
      },
    ];
  }

  // Group by source file's directory
  const dirMap = new Map<
    string,
    { hints: UnresolvedHint[]; holes: TypeHoleResult[]; files: Set<string> }
  >();

  for (const hint of unresolvedHints) {
    const dir = hint.file.substring(0, hint.file.lastIndexOf("/"));
    if (!dirMap.has(dir))
      dirMap.set(dir, { hints: [], holes: [], files: new Set() });
    const group = dirMap.get(dir)!;
    group.hints.push(hint);
    group.files.add(hint.file);
  }

  for (const hole of typeHoleHints) {
    const dir = hole.file.substring(0, hole.file.lastIndexOf("/"));
    if (!dirMap.has(dir))
      dirMap.set(dir, { hints: [], holes: [], files: new Set() });
    const group = dirMap.get(dir)!;
    group.holes.push(hole);
    group.files.add(hole.file);
  }

  // Convert to WorkGroups, capping at maxGroups
  const entries = [...dirMap.entries()];
  const groups: WorkGroup[] = [];

  for (let i = 0; i < entries.length && groups.length < maxGroups; i++) {
    const [, { hints, holes, files }] = entries[i];
    groups.push({
      id: groups.length,
      changedFiles: [...files],
      unresolvedHints: hints,
      typeHoleHints: holes,
    });
  }

  // Merge remaining entries into the last group
  if (entries.length > maxGroups && groups.length > 0) {
    const last = groups[groups.length - 1];
    for (let i = maxGroups; i < entries.length; i++) {
      const [, { hints, holes, files }] = entries[i];
      last.unresolvedHints.push(...hints);
      last.typeHoleHints.push(...holes);
      for (const f of files) {
        last.changedFiles.push(f);
      }
    }
  }

  // If we only ended up with one group, no point parallelizing
  if (groups.length <= 1) {
    return [
      {
        id: 0,
        changedFiles,
        unresolvedHints,
        typeHoleHints,
      },
    ];
  }

  return groups;
}
