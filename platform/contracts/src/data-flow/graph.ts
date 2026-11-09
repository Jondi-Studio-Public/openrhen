import { ACTIVITY_SOURCES } from "../activity-events.js";
import { BLIND_TABLES, PLAN_INPUT_TABLES, isSurfaceRef, surfaceHasValue, surfaceLabel } from "./surfaces.js";
import {
  parseDatasetRef,
  type DatasetNote,
  type DatasetRef,
  type DeviceId,
  type FlowEntry,
  type ParsedDataset
} from "./types.js";

/**
 * The registry as a graph (design 2.4, 2.5, 4.5). Pure: it takes the entries, the table list and nothing else, so the
 * portal, the CLI and the tests all ask it the same questions. Value is computed here, never written by hand: an
 * entry's reach is the set of value surfaces its output datasets arrive at through readers that consume them.
 */

export interface FlowRegistry {
  entries: readonly FlowEntry[];
  datasets: readonly DatasetNote[];
  /** One flag per build: the entries are pinned (composed) rather than merged. */
  composedBuild: boolean;
}

export interface GraphOptions {
  /** The kinds one activity source takes; defaults to the contracts' own list. */
  kindsOf?: (source: string) => readonly string[];
  /** Defaults to `plan-input-tables.json`. */
  planInput?: readonly string[];
  /** Defaults to `BLIND_TABLES`. */
  blind?: readonly string[];
}

export interface Reach {
  surface: DatasetRef;
  /** Entry ids from the first reader after the source to the one that claims the surface. */
  readers: string[];
  /** The `gives` lines on that path, in order. */
  gives: string[];
}

export interface UnusedEntry {
  id: string;
  /** `unused`: collected and reaches nothing. `nothing-sends`: accepted, but no producer posts it. */
  bucket: "unused" | "nothing-sends";
}

export interface EngineUse {
  /** The entry's reach includes the engine. */
  reads: boolean;
  /** Plan-input tables it writes that the engine reader does not consume. */
  blindInFact: string[];
  /** It writes tables, and only ones the engine is blind to on purpose. */
  blindByDesign: boolean;
}

export interface DeviceNode {
  id: DeviceId;
  ref: DatasetRef;
  entries: string[];
}

const present = (entry: FlowEntry) => entry.planned === undefined;

/** Whether two dataset names can describe some of the same rows. A filter present on one side only does not exclude. */
export function datasetsOverlap(a: ParsedDataset, b: ParsedDataset): boolean {
  if (a.scheme !== b.scheme || a.name !== b.name) return false;
  for (const [key, value] of Object.entries(a.filters)) {
    const other = b.filters[key];
    if (other === undefined || value === "*" || other === "*") continue;
    if (other !== value) return false;
  }
  return true;
}

export type DataFlowGraph = ReturnType<typeof buildFlowGraph>;

export function buildFlowGraph(tables: readonly string[], registry: FlowRegistry, options: GraphOptions = {}) {
  const kindsOf = options.kindsOf ?? ((source: string) => ACTIVITY_SOURCES[source]?.kinds ?? []);
  const planInput = options.planInput ?? PLAN_INPUT_TABLES;
  const blind = options.blind ?? BLIND_TABLES;
  const entries = [...registry.entries];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parsed = (ref: string) => parseDatasetRef(ref);

  /**
   * What an entry writes: its `to` plus, behind a pipe, the partition of its activity source, or, with no activity
   * source, the datasets the pipe writes.
   */
  function writes(id: string): DatasetRef[] {
    const entry = byId.get(id);
    if (!entry) return [];
    const out = new Set<DatasetRef>(entry.to);
    for (const pipeId of entry.via ?? []) {
      const pipe = byId.get(pipeId);
      for (const ref of pipe?.to ?? []) {
        if (entry.activitySource === undefined) out.add(ref);
        else if (ref === "pg:activity_events") out.add(`pg:activity_events[source=${entry.activitySource}]`);
      }
    }
    return [...out];
  }

  /** Readers and sinks that are live and count as use. */
  const consumers = entries.filter(
    (entry) => present(entry) && (entry.role === "reader" || entry.role === "sink") && entry.passThrough !== true
  );

  function consuming(dataset: ParsedDataset): FlowEntry[] {
    return consumers.filter((entry) =>
      entry.from.some((ref) => {
        const from = parsed(ref);
        return from !== null && datasetsOverlap(from, dataset);
      })
    );
  }

  /** Walks from datasets (and entries handed work in process) to the value surfaces they arrive at. */
  function walk(start: readonly DatasetRef[], feeds: readonly string[] = []): Reach[] {
    const seenDatasets = new Set<string>();
    const seenReaders = new Set<string>();
    const found = new Map<string, Reach>();
    type Item = { ref: DatasetRef; readers: string[]; gives: string[] };
    const queue: Item[] = start.map((ref) => ({ ref, readers: [], gives: [] }));
    const visit = (entry: FlowEntry, via: Item) => {
      if (seenReaders.has(entry.id)) return;
      seenReaders.add(entry.id);
      const readers = [...via.readers, entry.id];
      const gives = entry.gives ? [...via.gives, entry.gives] : via.gives;
      for (const ref of entry.to) {
        if (isSurfaceRef(ref)) {
          if (surfaceHasValue(ref) && !found.has(ref)) found.set(ref, { surface: ref, readers, gives });
        } else queue.push({ ref, readers, gives });
      }
      for (const fedId of entry.feeds ?? []) {
        const fed = byId.get(fedId);
        if (fed && present(fed) && fed.passThrough !== true) visit(fed, { ref: via.ref, readers, gives });
      }
    };
    for (const fedId of feeds) {
      const fed = byId.get(fedId);
      if (fed && present(fed) && fed.passThrough !== true) visit(fed, { ref: "pg:", readers: [], gives: [] });
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (seenDatasets.has(item.ref)) continue;
      seenDatasets.add(item.ref);
      const dataset = parsed(item.ref);
      if (!dataset || dataset.scheme === "surface") continue;
      for (const reader of consuming(dataset)) visit(reader, item);
    }
    return [...found.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  }

  function reach(id: string): Reach[] {
    const entry = byId.get(id);
    if (!entry || !present(entry) || entry.passThrough === true) return [];
    return walk(writes(id), entry.feeds ?? []);
  }

  function reachLabel(id: string): string {
    const entry = byId.get(id);
    const lines = reach(id).map((r) => `${surfaceLabel(r.surface)}${r.gives.length ? `: ${r.gives.at(-1)}` : ""}`);
    if (lines.length > 0) return lines.join("; ");
    return entry?.noProducer === true ? "accepted, nothing sends" : "collected, gives nothing yet";
  }

  function unused() {
    const out: UnusedEntry[] = [];
    const kinds: { source: string; kinds: string[] }[] = [];
    for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!present(entry) || entry.role !== "source" || entry.passThrough === true) continue;
      if (entry.noProducer === true) {
        out.push({ id: entry.id, bucket: "nothing-sends" });
        continue;
      }
      const reached = reach(entry.id);
      if (reached.length === 0) {
        out.push({ id: entry.id, bucket: "unused" });
        continue;
      }
      const source = entry.activitySource;
      if (source === undefined) continue;
      const skipped = kindsOf(source).filter(
        (kind) => walk([`pg:activity_events[source=${source},kind=${kind}]`]).length === 0
      );
      if (skipped.length > 0) kinds.push({ source, kinds: skipped });
    }
    const dead = new Set(registry.datasets.filter((note) => note.dead !== undefined).map((note) => note.ref));
    const infrastructure = new Set(
      registry.datasets.filter((note) => note.infrastructure !== undefined).map((note) => note.ref)
    );
    const known = new Set(tables);
    const written = new Set<DatasetRef>();
    for (const entry of entries) {
      if (!present(entry)) continue;
      for (const ref of entry.to) {
        const dataset = parsed(ref);
        if (dataset?.scheme === "pg" && known.has(dataset.name)) written.add(`pg:${dataset.name}`);
      }
    }
    const datasets = [...written]
      .filter((ref) => !dead.has(ref) && !infrastructure.has(ref) && walk([ref]).length === 0)
      .sort();
    return { entries: out, kinds, datasets, dead: [...dead].sort() };
  }

  function devices(): DeviceNode[] {
    const byDevice = new Map<string, string[]>();
    for (const entry of entries) {
      if (!present(entry) || entry.device === undefined) continue;
      byDevice.set(entry.device, [...(byDevice.get(entry.device) ?? []), entry.id]);
    }
    return [...byDevice.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, ids]) => ({ id, ref: `ext:device/${id}` as DatasetRef, entries: ids.sort() }));
  }

  function engineUse(id: string): EngineUse {
    const written = writes(id)
      .map(parsed)
      .filter((dataset): dataset is ParsedDataset => dataset?.scheme === "pg")
      .map((dataset) => dataset.name);
    const engineReader = consumers.find((entry) => entry.to.includes("surface:engine"));
    const consumed = new Set(
      (engineReader?.from ?? []).map(parsed).flatMap((dataset) => (dataset?.scheme === "pg" ? [dataset.name] : []))
    );
    const blindInFact = [
      ...new Set(written.filter((table) => planInput.includes(table) && !consumed.has(table)))
    ].sort();
    return {
      reads: reach(id).some((r) => r.surface === "surface:engine"),
      blindInFact,
      blindByDesign: written.length > 0 && written.every((table) => blind.includes(table))
    };
  }

  return {
    tables,
    entries,
    entry: (id: string) => byId.get(id),
    writes,
    reach,
    reachLabel,
    unused,
    devices,
    engineUse,
    /** Datasets read from a partition or table by anything live (readers and sinks). */
    consumers: (ref: DatasetRef) => {
      const dataset = parsed(ref);
      return dataset ? consuming(dataset).map((entry) => entry.id) : [];
    },
    composedBuild: registry.composedBuild
  };
}
