import { buildFlowGraph, type FlowRegistry, type UnusedEntry } from "./graph.js";
import type { DatasetNote, DatasetRef, FlowEntry } from "./types.js";
import { parseDatasetRef } from "./types.js";

/** The registry as the API, the CLI and the page see it: entries with computed reach, edges, devices, unused. */

export interface ViewEntry extends FlowEntry {
  /** Where the entry's data ends up, or "collected, gives nothing yet" / "accepted, nothing sends". */
  reach: string;
}

export interface ViewEdge {
  /** An entry id or a dataset ref. */
  from: string;
  to: string;
  kind: "reads" | "writes";
}

export interface DataFlowView {
  build: "merged" | "pinned";
  entries: ViewEntry[];
  datasets: DatasetNote[];
  edges: ViewEdge[];
  devices: { id: string; ref: DatasetRef; entries: string[] }[];
  unused: {
    entries: UnusedEntry[];
    kinds: { source: string; kinds: string[] }[];
    datasets: DatasetRef[];
    dead: DatasetRef[];
  };
}

/** The tables the registry names, for a build that has no schema to hand (`rhen sources --offline`). */
export function registryTables(registry: FlowRegistry): string[] {
  const names = new Set<string>();
  for (const ref of [
    ...registry.entries.flatMap((entry) => [...entry.from, ...entry.to]),
    ...registry.datasets.map((note) => note.ref)
  ]) {
    const parsed = parseDatasetRef(ref);
    if (parsed?.scheme === "pg") names.add(parsed.name);
  }
  return [...names].sort();
}

export function buildDataFlowView(
  tables: readonly string[],
  registry: FlowRegistry & { composedBuild?: boolean }
): DataFlowView {
  const graph = buildFlowGraph(tables, registry);
  const present = registry.entries.filter((entry) => entry.planned === undefined);
  const edges: ViewEdge[] = [];
  for (const entry of present) {
    for (const ref of entry.from) edges.push({ from: ref, to: entry.id, kind: "reads" });
    for (const ref of graph.writes(entry.id)) edges.push({ from: entry.id, to: ref, kind: "writes" });
  }
  return {
    build: registry.composedBuild === true ? "pinned" : "merged",
    entries: registry.entries.map((entry) => ({ ...entry, reach: graph.reachLabel(entry.id) })),
    datasets: [...registry.datasets],
    edges,
    devices: graph.devices(),
    unused: graph.unused()
  };
}
