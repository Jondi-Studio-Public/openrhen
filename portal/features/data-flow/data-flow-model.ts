import type { DeviceHealth, HealthIssue, NodeHealth, ViewEntry } from "@openrhen/contracts/data-flow";
import type { DataFlowResponse } from "@openrhen/contracts/data-flow";

/**
 * The /data page's view model: `GET /api/data-flow` reshaped into five columns of nodes and the edges between them.
 * Pure (no clock of its own, no DOM), so the layout, the list and the panel all read one thing.
 *
 * Columns: external systems and devices, collectors and pipes, stores (collapsed into groups), readers, value surfaces.
 */

export type NodeKind = "external" | "device" | "collector" | "store" | "reader" | "surface";
/** green fresh, amber late or unused, red stale or failing, grey n/a or not set up, hollow never heard from. */
export type Tone = "green" | "amber" | "red" | "grey" | "hollow";

export const COLUMN_TITLES = ["Outside", "Collectors", "Stores", "Readers", "What it gives"] as const;
export const COLUMN_COUNT = COLUMN_TITLES.length;

export interface FlowNode {
  id: string;
  kind: NodeKind;
  /** 0 to 4, or -1 for a planned entry (its own lane). */
  column: number;
  label: string;
  /** The second line: the status in words and the age, so colour is never the only signal. */
  detail: string;
  tone: Tone;
  planned: boolean;
  /** Backup and raw REST: data passes through without anyone using it. */
  passThrough: boolean;
  /** A problem needs a look; `unused` is the milder "collected, nothing reads it". */
  attention: "problem" | "unused" | null;
  reachesEngine: boolean;
  entry?: ViewEntry;
  health?: NodeHealth | undefined;
  issues: HealthIssue[];
  device?: DeviceHealth | undefined;
  /** Stores: the tables behind a group. */
  tables?: string[];
  /** Expandable stores (the activity store). */
  expandable?: boolean;
  /** Value surfaces: what each reader (or writer, when it states nothing) says it gives. */
  gives?: { by: string; text: string | null }[] | undefined;
  /** In the header's counts: collected but unused, or accepted with nothing sending. */
  bucket?: "unused" | "nothing-sends" | undefined;
  /** A fold: the entries it stands for, shown one by one when it is opened. */
  folded?: string[] | undefined;
  foldedNames?: string[] | undefined;
  /** Grey "gives nothing yet" marker text for collectors that reach nothing. */
  marker?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** Solid when the path reaches the engine, dotted where the engine is blind. */
  engine: boolean;
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: FlowEdge[];
  byId: Map<string, FlowNode>;
  build: "merged" | "pinned";
  generatedAt: string;
  healthAvailable: boolean;
  healthReason?: string | undefined;
  /** The next step the server gives when health is unavailable, when it gives one. */
  healthNext?: string | undefined;
  categories: string[];
  owners: string[];
  counts: FlowCounts;
}

export interface FlowCounts {
  late: number;
  silent: number;
  devicesSilent: number;
  unused: number;
  nothingSends: number;
}

export interface FlowFilters {
  category: string | null;
  reachesEngine: boolean;
  problemsOnly: boolean;
  showPlanned: boolean;
  /** Only the sources the header counts as collected but unused, or accepted with nothing sending. */
  unusedOnly: boolean;
  /** `core` or `private`; null shows both. */
  owner: "core" | "private" | null;
}

export const DEFAULT_FILTERS: FlowFilters = {
  category: null,
  reachesEngine: false,
  problemsOnly: false,
  showPlanned: true,
  unusedOnly: false,
  owner: null
};

const ACTIVITY_GROUP = "store:activity";
/** Tables the registry marks as machinery (queues, credentials, ledgers): one store until opened. */
export const MACHINERY_GROUP = "store:machinery";
const FILES_NODE = "files";

const HOUR = 3_600_000;

/** "just now", "5 min ago", "2 h ago", "3 d ago"; "never" when there is no time. */
export function ageText(iso: string | null | undefined, now: Date): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never";
  if (ms < 60_000) return "just now";
  if (ms < HOUR) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h ago`;
  return `${Math.round(ms / (24 * HOUR))} d ago`;
}

const humanise = (value: string): string => {
  const text = value.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

interface Parsed {
  scheme: string;
  name: string;
  filters: Record<string, string>;
}

function parseRef(ref: string): Parsed | null {
  const match = /^(pg|blob|local|ext|surface):([^[\]]+)(?:\[([^\]]*)\])?$/.exec(ref);
  if (!match) return null;
  const filters: Record<string, string> = {};
  for (const part of (match[3] ?? "").split(",").filter(Boolean)) {
    const at = part.indexOf("=");
    if (at > 0) filters[part.slice(0, at)] = part.slice(at + 1);
  }
  return { scheme: match[1]!, name: match[2]!, filters };
}

/** A plain label for a value surface. Never a registry id: an outside system's id is shown as its kind, not its name. */
const SURFACE_KIND_LABELS: Record<string, string> = {
  engine: "Planning engine",
  push: "Push notifications",
  backup: "Backup",
  rest: "Raw REST read",
  tool: "Agent tool",
  device: "Handheld screen",
  external: "Outbound publish"
};

function surfaceLabel(name: string): string {
  const [kind, ...rest] = name.split("/");
  if (kind === "page") return humanise(rest.at(-1) ?? "page");
  return SURFACE_KIND_LABELS[kind ?? ""] ?? humanise(kind ?? name);
}

interface Placement {
  id: string;
  kind: NodeKind;
  column: number;
  label: string;
  table?: string;
  surface?: string;
}

const TONE_RANK: Record<Tone, number> = { red: 0, amber: 1, hollow: 2, green: 3, grey: 4 };

/** Which tone is worst for a device made of several entries. */
function worstTone(tones: Tone[]): Tone {
  const live = tones.filter((tone) => tone !== "grey");
  const pool = live.length > 0 ? live : tones;
  return pool.sort((a, b) => TONE_RANK[a] - TONE_RANK[b])[0] ?? "grey";
}

interface EntryStatus {
  tone: Tone;
  text: string;
  attention: FlowNode["attention"];
}

function entryStatus(
  entry: ViewEntry,
  health: NodeHealth | undefined,
  available: boolean,
  unusedBucket: "unused" | "nothing-sends" | undefined
): EntryStatus {
  if (entry.planned !== undefined) return { tone: "grey", text: "Planned", attention: null };
  if (entry.noProducer) return { tone: "grey", text: "Nothing sends yet", attention: null };
  if (!available) return { tone: "grey", text: "Health unavailable", attention: null };
  if (!health) return { tone: "grey", text: "Not tracked", attention: null };
  switch (health.freshness) {
    case "fresh":
      return unusedBucket === "unused"
        ? { tone: "amber", text: "Unused", attention: "unused" }
        : { tone: "green", text: "Fresh", attention: null };
    case "late":
      return { tone: "amber", text: "Late", attention: "problem" };
    case "stale":
      return { tone: "red", text: "Stale", attention: "problem" };
    case "failing":
      return { tone: "red", text: "Failing", attention: "problem" };
    case "probe_unresolved":
      return { tone: "red", text: "Check unresolved", attention: "problem" };
    case "never":
      return health.configured
        ? { tone: "hollow", text: "Never heard from", attention: "problem" }
        : { tone: "grey", text: "Not set up", attention: null };
    default:
      return { tone: "grey", text: "Not tracked", attention: null };
  }
}

/** A short, generic name for a set of tables that share a neighbourhood. */
function groupLabel(tables: readonly string[]): string {
  const names = [...tables].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const first = names.slice(0, 2).map(humanise);
  return names.length > 2 ? `${first.join(", ")} +${names.length - 2}` : first.join(", ");
}

export interface BuildOptions {
  now: Date;
  /** Group keys opened into their parts: `store:activity` into one row per source, `fold:<category>` into its entries. */
  expanded?: ReadonlySet<string>;
  /** Draw every entry on its own: no folding (a filter is on, or the list view wants them all). */
  unfold?: boolean;
}

/** The id of the fold that holds a category's idle collectors. */
export const foldId = (category: string): string => `fold:${category}`;

export function buildFlowModel(data: DataFlowResponse, options: BuildOptions): FlowModel {
  const { now } = options;
  const expanded = options.expanded ?? new Set<string>();
  const available = data.health.unavailable !== true;
  const healthNodes = data.health.unavailable ? {} : data.health.nodes;
  const issues = data.health.unavailable ? [] : data.health.issues;
  const bucket = new Map(data.unused.entries.map((item) => [item.id, item.bucket] as const));
  const entries = new Map(data.entries.map((entry) => [entry.id, entry]));
  const machinery = new Set(
    data.datasets.flatMap((note) => {
      const parsed = note.infrastructure ? parseRef(note.ref) : null;
      return parsed?.scheme === "pg" ? [parsed.name] : [];
    })
  );
  const noteGroup = new Map(data.datasets.flatMap((note) => (note.group ? [[note.ref, note.group] as const] : [])));

  // Idle collectors (never set up, nothing ever arrived) fold into one node per category, so the map is not a wall of
  // grey boxes. A category folds only when it has two or more; opening a fold, or any filter, shows them one by one.
  const foldOf = new Map<string, string>();
  const foldMembers = new Map<string, string[]>();
  if (available && options.unfold !== true) {
    const idle = new Map<string, string[]>();
    for (const entry of data.entries) {
      if (entry.planned !== undefined || entry.noProducer || entry.passThrough) continue;
      if (entry.role !== "source") continue;
      const health = healthNodes[entry.id];
      if (health?.lastSuccessAt) continue;
      const status = entryStatus(entry, health, available, bucket.get(entry.id));
      if (status.tone !== "grey" || status.attention !== null) continue;
      if (issues.some((issue) => issue.entryId === entry.id)) continue;
      idle.set(entry.category, [...(idle.get(entry.category) ?? []), entry.id]);
    }
    for (const [category, ids] of idle) {
      if (ids.length < 2 || expanded.has(foldId(category))) continue;
      foldMembers.set(foldId(category), ids);
      for (const id of ids) foldOf.set(id, foldId(category));
    }
  }
  const mapId = (id: string) => foldOf.get(id) ?? id;

  // Which entries touch each table, so tables with the same neighbourhood draw as one store.
  const touching = new Map<string, Set<string>>();
  const touch = (table: string, id: string) => {
    if (!touching.has(table)) touching.set(table, new Set());
    touching.get(table)!.add(id);
  };
  const refTable = (ref: string) => {
    const parsed = parseRef(ref);
    return parsed?.scheme === "pg" ? parsed.name : null;
  };
  for (const edge of data.edges) {
    const fromTable = refTable(edge.from);
    const toTable = refTable(edge.to);
    if (fromTable) touch(fromTable, `${mapId(edge.to)}>`);
    if (toTable) touch(toTable, `<${mapId(edge.from)}`);
  }
  // The one table split into per-source partitions (`pg:<table>[source=x]`) is the activity store.
  const partitioned = new Set<string>();
  for (const edge of data.edges)
    for (const ref of [edge.from, edge.to]) {
      const parsed = parseRef(ref);
      if (parsed?.scheme === "pg" && parsed.filters.source !== undefined) partitioned.add(parsed.name);
    }
  const groupOfTable = new Map<string, string>();
  const groupTables = new Map<string, string[]>();
  const groupNames = new Map<string, string>();
  for (const [table, neighbours] of [...touching].sort(([a], [b]) => a.localeCompare(b))) {
    let key: string;
    if (partitioned.has(table)) key = ACTIVITY_GROUP;
    else if (machinery.has(table) && !expanded.has(MACHINERY_GROUP)) key = MACHINERY_GROUP;
    else {
      const named = noteGroup.get(`pg:${table}`);
      key = named ? `store:named/${named}` : `store:set/${[...neighbours].sort().join("|")}`;
      if (named) groupNames.set(key, named);
    }
    groupOfTable.set(table, key);
    groupTables.set(key, [...(groupTables.get(key) ?? []), table]);
  }

  const placements = new Map<string, Placement>();
  const place = (ref: string): Placement | null => {
    const hit = placements.get(ref);
    if (hit) return hit;
    const parsed = parseRef(ref);
    if (!parsed) return null;
    let result: Placement | null = null;
    if (parsed.scheme === "pg") {
      const group = groupOfTable.get(parsed.name);
      if (!group) return null;
      if (group === ACTIVITY_GROUP && expanded.has(ACTIVITY_GROUP)) {
        const source = parsed.filters.source ?? "*";
        result = {
          id: `${ACTIVITY_GROUP}/${source}`,
          kind: "store",
          column: 2,
          label: source === "*" ? "All sources" : humanise(source),
          table: parsed.name
        };
      } else {
        result = {
          id: group,
          kind: "store",
          column: 2,
          label:
            group === ACTIVITY_GROUP
              ? "Activity store"
              : group === MACHINERY_GROUP
                ? "Machinery tables"
                : (groupNames.get(group) ?? groupLabel(groupTables.get(group) ?? [parsed.name])),
          table: parsed.name
        };
      }
    } else if (parsed.scheme === "surface") {
      result = {
        id: `surface:${parsed.name}`,
        kind: "surface",
        column: 4,
        label: surfaceLabel(parsed.name),
        surface: parsed.name
      };
    } else if (parsed.scheme === "local") {
      result = { id: FILES_NODE, kind: "external", column: 0, label: "Files you import" };
    } else if (parsed.name.startsWith("device/")) {
      const id = parsed.name.slice("device/".length);
      result = { id: `device:${id}`, kind: "device", column: 0, label: humanise(id) };
    } else {
      result = { id: `ext:${parsed.name}`, kind: "external", column: 0, label: humanise(parsed.name) };
    }
    placements.set(ref, result);
    return result;
  };

  const nodes = new Map<string, FlowNode>();
  const ensure = (placement: Placement): FlowNode => {
    let node = nodes.get(placement.id);
    if (!node) {
      node = {
        id: placement.id,
        kind: placement.kind,
        column: placement.column,
        label: placement.label,
        detail: "",
        tone: "grey",
        planned: false,
        passThrough: placement.surface === "backup" || placement.surface === "rest",
        attention: null,
        reachesEngine: false,
        issues: []
      };
      if (placement.kind === "store") {
        node.tables = [];
        if (placement.id.startsWith(ACTIVITY_GROUP) || placement.id === MACHINERY_GROUP) node.expandable = true;
      }
      nodes.set(placement.id, node);
    }
    if (placement.kind === "store" && placement.table && !node.tables!.includes(placement.table))
      node.tables!.push(placement.table);
    return node;
  };

  // Entry nodes.
  for (const entry of data.entries) {
    if (foldOf.has(entry.id)) continue;
    const status = entryStatus(entry, healthNodes[entry.id], available, bucket.get(entry.id));
    const planned = entry.planned !== undefined;
    const health = healthNodes[entry.id];
    const showAge = !planned && available && health && !entry.noProducer && status.text !== "Not set up";
    const node: FlowNode = {
      id: entry.id,
      kind: entry.role === "reader" || entry.role === "sink" ? "reader" : "collector",
      column: planned ? -1 : entry.role === "reader" || entry.role === "sink" ? 3 : 1,
      label: entry.name,
      detail: showAge ? `${status.text} · ${ageText(health.lastSuccessAt, now)}` : status.text,
      tone: status.tone,
      planned,
      passThrough: entry.passThrough === true,
      attention: status.attention,
      reachesEngine: false,
      entry,
      health,
      bucket: bucket.get(entry.id),
      issues: issues.filter((issue) => issue.entryId === entry.id)
    };
    if (!planned && entry.reach.startsWith("collected, gives nothing")) node.marker = "gives nothing yet";
    if (!planned && entry.noProducer) node.marker = "nothing sends";
    nodes.set(entry.id, node);
  }

  for (const [id, members] of foldMembers) {
    nodes.set(id, {
      id,
      kind: "collector",
      column: 1,
      label: `${members.length} more not set up`,
      detail: entries.get(members[0]!)!.category,
      tone: "grey",
      planned: false,
      passThrough: false,
      attention: null,
      reachesEngine: false,
      issues: [],
      folded: members,
      foldedNames: members.map((member) => entries.get(member)!.name)
    });
  }

  // Edges, deduplicated, with every end mapped onto a node.
  const edgeKeys = new Set<string>();
  const edges: FlowEdge[] = [];
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, engine: false });
  };
  for (const edge of data.edges) {
    // An edge from a surface is the engine handing something back to a collector; it does not draw.
    if (edge.from.startsWith("surface:")) continue;
    const fromEntry = entries.has(edge.from);
    const toEntry = entries.has(edge.to);
    if (fromEntry && entries.get(edge.from)!.planned) continue;
    const from = fromEntry ? { id: mapId(edge.from) } : place(edge.from);
    const to = toEntry ? { id: mapId(edge.to) } : place(edge.to);
    if (!from || !to) continue;
    if (!fromEntry) ensure(from as Placement);
    if (!toEntry) ensure(to as Placement);
    addEdge(from.id, to.id);
  }

  // Devices.
  const deviceHealth = new Map((data.health.unavailable ? [] : data.health.devices).map((d) => [d.id, d]));
  for (const device of data.devices) {
    const placement = place(device.ref);
    if (!placement) continue;
    const node = ensure(placement);
    const memberTones = device.entries
      .map((id) => nodes.get(id))
      .filter(
        (member): member is FlowNode => member !== undefined && !member.planned && member.marker !== "nothing sends"
      )
      .map((member) => member.tone);
    const live =
      deviceHealth.get(device.id) ??
      (device.lastSeenAt
        ? { ...device, lastSeenAt: device.lastSeenAt, lastSeenFrom: device.lastSeenFrom ?? null }
        : undefined);
    node.device = live as DeviceHealth | undefined;
    if (!available) {
      node.detail = "Health unavailable";
    } else if (live?.lastSeenAt) {
      const from = live.lastSeenFrom ? entries.get(live.lastSeenFrom)?.name.toLowerCase() : undefined;
      node.detail = `last seen ${ageText(live.lastSeenAt, now)}${from ? ` (${from})` : ""}`;
      node.tone = memberTones.length > 0 ? worstTone(memberTones) : "green";
    } else {
      node.detail = "never seen";
      node.tone = memberTones.length > 0 ? worstTone(memberTones) : "hollow";
      if (node.tone === "grey") node.tone = "hollow";
    }
    for (const id of device.entries.map(mapId)) if (nodes.has(id) && !nodes.get(id)!.planned) addEdge(node.id, id);
  }

  // Reach: which nodes have a path to the engine.
  const reverse = new Map<string, string[]>();
  for (const edge of edges) reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge.from]);
  const queue = ["surface:engine"].filter((id) => nodes.has(id));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    nodes.get(id)!.reachesEngine = true;
    for (const upstream of reverse.get(id) ?? [])
      if (!seen.has(upstream)) {
        seen.add(upstream);
        queue.push(upstream);
      }
  }
  for (const edge of edges) edge.engine = nodes.get(edge.to)?.reachesEngine === true;

  // Store and surface lines.
  for (const node of nodes.values()) {
    if (node.kind === "store") node.detail = `${node.tables!.length} table${node.tables!.length === 1 ? "" : "s"}`;
    else if (node.kind === "surface") {
      const ref = node.id;
      const touching = data.entries.filter((entry) => entry.planned === undefined && entry.to.includes(ref as never));
      node.gives = touching.map((entry) => ({ by: entry.name, text: entry.gives ?? null }));
      const lines = [...new Set(touching.flatMap((entry) => (entry.gives ? [entry.gives] : [])))];
      node.detail = node.passThrough
        ? "pass-through"
        : lines.length > 0
          ? lines.join("; ")
          : touching.map((entry) => entry.name).join("; ");
    } else if (node.kind === "external") node.detail = node.id === FILES_NODE ? "file imports" : "outside";
  }

  const all = [...nodes.values()].sort((a, b) => a.column - b.column || a.id.localeCompare(b.id));
  const present = data.entries.filter((entry) => entry.planned === undefined);
  const counts: FlowCounts = {
    late: 0,
    silent: 0,
    devicesSilent: 0,
    unused: data.unused.entries.filter((item) => item.bucket === "unused").length,
    nothingSends: data.unused.entries.filter((item) => item.bucket === "nothing-sends").length
  };
  if (available) {
    for (const entry of present) {
      const node = nodes.get(entry.id);
      if (!node) continue;
      if (node.tone === "red" || (node.tone === "amber" && node.attention === "problem")) counts.late += 1;
      else if (node.tone === "hollow") counts.silent += 1;
    }
    for (const node of all)
      if (node.kind === "device" && node.device !== undefined) {
        const members = (node.device.entries ?? [])
          .map((id) => nodes.get(id))
          .filter((m): m is FlowNode => !!m && !m.planned && m.tone !== "grey");
        if (members.length > 0 && members.every((m) => m.tone === "red" || m.tone === "amber" || m.tone === "hollow"))
          counts.devicesSilent += 1;
      }
  } else {
    counts.unused = 0;
    counts.nothingSends = 0;
  }

  return {
    nodes: all,
    edges,
    byId: nodes,
    build: data.build,
    generatedAt: data.generatedAt,
    healthAvailable: available,
    healthReason: data.health.unavailable ? data.health.reason : undefined,
    healthNext: data.health.unavailable ? data.health.next : undefined,
    categories: [...new Set(present.map((entry) => entry.category))].sort(),
    owners: [...new Set(data.entries.map((entry) => entry.owner ?? "core"))].sort(),
    counts
  };
}

/** The value surfaces a node reaches, with what each gives, read from the drawn graph rather than a registry string. */
export function reachSteps(model: FlowModel, id: string): { label: string; gives: string }[] {
  const out = new Map<string, FlowEdge[]>();
  for (const edge of model.edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  const seen = new Set([id]);
  const queue = [id];
  const steps: { label: string; gives: string }[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of out.get(current) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const node = model.byId.get(edge.to);
      if (!node) continue;
      if (node.kind === "surface") {
        if (!node.passThrough) steps.push({ label: node.label, gives: node.detail });
      } else queue.push(edge.to);
    }
  }
  return steps.sort((a, b) => a.label.localeCompare(b.label));
}

/** The counts line for the page and the Connections and You headers: "4 late · 1 device silent · 11 collected, unused". */
export function countsLine(model: Pick<FlowModel, "counts" | "healthAvailable">): string {
  if (!model.healthAvailable) return "Health unavailable";
  const { late, silent, devicesSilent, unused, nothingSends } = model.counts;
  const parts = [
    late > 0 ? `${late} late` : "",
    silent > 0 ? `${silent} silent` : "",
    devicesSilent > 0 ? `${devicesSilent} device${devicesSilent === 1 ? "" : "s"} silent` : "",
    unused > 0 ? `${unused} collected, unused` : "",
    nothingSends > 0 ? `${nothingSends} accepted, nothing sends` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Everything collected is arriving";
}

/**
 * The nodes and edges that survive the filters. Entries are filtered directly; outside systems, stores and surfaces stay
 * only while an edge still joins them to a surviving node, so a filter never leaves orphans.
 */
export function applyFilters(model: FlowModel, filters: FlowFilters): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const keepEntry = (node: FlowNode): boolean => {
    if (node.planned && (!filters.showPlanned || filters.problemsOnly || filters.reachesEngine || filters.unusedOnly))
      return false;
    const entry = node.entry!;
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.owner) {
      const isCore = (entry.owner ?? "core") === "core";
      if (filters.owner === "core" ? !isCore : isCore) return false;
    }
    if (filters.problemsOnly && node.attention !== "problem") return false;
    if (filters.unusedOnly && node.bucket === undefined) return false;
    if (filters.reachesEngine && !node.reachesEngine) return false;
    return true;
  };
  const kept = new Set<string>();
  for (const node of model.nodes) if (node.entry && keepEntry(node)) kept.add(node.id);
  const filtering =
    filters.category !== null ||
    filters.owner !== null ||
    filters.problemsOnly ||
    filters.reachesEngine ||
    filters.unusedOnly;
  if (!filtering) {
    for (const node of model.nodes) if (!node.entry) kept.add(node.id);
    return {
      nodes: model.nodes.filter((node) => kept.has(node.id)),
      edges: model.edges
    };
  }
  // Devices and outside systems join the collectors that survive; stores and surfaces join through an edge to one.
  const edges = model.edges.filter((edge) => {
    const from = model.byId.get(edge.from);
    const to = model.byId.get(edge.to);
    return (
      from !== undefined &&
      to !== undefined &&
      (from.entry ? kept.has(from.id) : true) &&
      (to.entry ? kept.has(to.id) : true)
    );
  });
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  // A non-entry node needs a surviving entry on one of its edges, not just another non-entry node.
  const anchored = new Set<string>();
  for (const edge of edges) {
    const from = model.byId.get(edge.from)!;
    const to = model.byId.get(edge.to)!;
    if (from.entry && kept.has(from.id)) anchored.add(to.id);
    if (to.entry && kept.has(to.id)) anchored.add(from.id);
  }
  for (const id of anchored) kept.add(id);
  const finalNodes = model.nodes.filter((node) => kept.has(node.id));
  const ids = new Set(finalNodes.map((node) => node.id));
  return { nodes: finalNodes, edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

export interface ListRowModel {
  id: string;
  name: string;
  tone: Tone;
  detail: string;
  planned: boolean;
  attention: FlowNode["attention"];
  /** The `from → via → to → reaches` chip strip. */
  chips: { kind: "from" | "via" | "to" | "reaches"; text: string }[];
}

const LIST_RANK = (row: ListRowModel): number => {
  if (row.planned) return 6;
  if (row.attention === "problem") return row.tone === "red" ? 0 : 1;
  if (row.attention === "unused") return 3;
  if (row.tone === "green") return 4;
  return 5;
};

/** One row per entry, problems first, for a phone. */
export function listRows(model: FlowModel, nodes: readonly FlowNode[], edges: readonly FlowEdge[]): ListRowModel[] {
  const shown = new Set(nodes.map((node) => node.id));
  const rows: ListRowModel[] = [];
  for (const node of nodes) {
    if (!node.entry) continue;
    const entry = node.entry;
    const upstream = edges
      .filter((edge) => edge.to === node.id && shown.has(edge.from))
      .map((edge) => model.byId.get(edge.from)!);
    const downstream = edges
      .filter((edge) => edge.from === node.id && shown.has(edge.to))
      .map((edge) => model.byId.get(edge.to)!);
    const chips: ListRowModel["chips"] = [];
    for (const source of upstream.filter((item) => item.kind === "external" || item.kind === "device"))
      chips.push({ kind: "from", text: source.label });
    for (const via of entry.via ?? []) chips.push({ kind: "via", text: model.byId.get(via)?.label ?? humanise(via) });
    for (const store of downstream.filter((item) => item.kind === "store"))
      chips.push({ kind: "to", text: store.label });
    const reached = reachSteps(model, node.id);
    if (reached.length === 0)
      chips.push({ kind: "reaches", text: entry.reach.startsWith("accepted") ? entry.reach : "gives nothing yet" });
    for (const step of reached.slice(0, 4))
      chips.push({ kind: "reaches", text: step.gives ? `${step.label}: ${step.gives}` : step.label });
    if (reached.length > 4) chips.push({ kind: "reaches", text: `+${reached.length - 4} more` });
    rows.push({
      id: node.id,
      name: node.label,
      tone: node.tone,
      detail: node.detail,
      planned: node.planned,
      attention: node.attention,
      chips
    });
  }
  return rows.sort((a, b) => LIST_RANK(a) - LIST_RANK(b) || a.name.localeCompare(b.name));
}

/** The trigger in words, for the panel. */
export function triggerText(trigger: ViewEntry["trigger"]): string {
  switch (trigger.kind) {
    case "loop":
      return `runs in the ${trigger.loop} loop`;
    case "connection-schedule":
      return "runs on the connection's schedule";
    case "on-write":
      return "runs when data is written";
    case "none":
      return "nothing starts it";
    case "on-request":
      return `runs when ${trigger.by === "owner" ? "you ask" : `${trigger.by} asks`}`;
    case "manual-run":
      return `run by hand (${trigger.where})`;
  }
}

export const toneWord: Record<Tone, string> = {
  green: "fresh",
  amber: "needs a look",
  red: "needs attention",
  grey: "not tracked",
  hollow: "never heard from"
};
