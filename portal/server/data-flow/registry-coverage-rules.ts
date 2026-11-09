import {
  parseDatasetRef,
  parseSurface,
  surfacePageFile,
  type DatasetNote,
  type FlowEntry
} from "@openrhen/contracts/data-flow";

/**
 * The coverage rules (design 3.2: A1, P1, C1, L1/L2, R1, R2, M1, T1, D1) and the write and surface evidence rules
 * (3.4: V1, V1-reverse, V2, V3), as pure functions like `registry-checks.ts`. The caller decides which entry points are
 * core-owned and passes only those; overlay-owned ones are exempt until the extension's own entries cover them.
 */

const present = (entry: FlowEntry) => entry.planned === undefined;
const live = (entries: readonly FlowEntry[]) => entries.filter(present);

/** A1: each activity source has at least one present entry (any role, `noProducer` included) carrying it. */
export function checkA1(sources: readonly string[], entries: readonly FlowEntry[]): string[] {
  const covered = new Set(live(entries).flatMap((entry) => (entry.activitySource ? [entry.activitySource] : [])));
  return sources.filter((source) => !covered.has(source)).map((source) => `activity source ${source} has no entry`);
}

/** P1: each parser or extractor file is in some entry's `code.paths`. */
export function checkP1(files: readonly string[], entries: readonly FlowEntry[]): string[] {
  const covered = new Set(live(entries).flatMap((entry) => entry.code.paths ?? []));
  return files
    .filter((file) => !covered.has(file))
    .map((file) => `parser or extractor ${file} is in no entry's code.paths`);
}

/** C1: each connection is some entry's `connection`. */
export function checkC1(connections: readonly string[], entries: readonly FlowEntry[]): string[] {
  const covered = new Set(live(entries).flatMap((entry) => (entry.connection ? [entry.connection] : [])));
  return connections.filter((id) => !covered.has(id)).map((id) => `connection ${id} is no entry's connection`);
}

/** L1 and L2: each loop is in some `code.loops`, or in the infra list with a reason. */
export function checkL1(
  loops: readonly string[],
  entries: readonly FlowEntry[],
  infraLoops: Readonly<Record<string, string>>
): string[] {
  const covered = new Set(live(entries).flatMap((entry) => entry.code.loops ?? []));
  const problems: string[] = [];
  for (const loop of loops) {
    if (loop in infraLoops) {
      if (infraLoops[loop]!.trim() === "") problems.push(`infra loop ${loop} needs a reason`);
    } else if (!covered.has(loop)) problems.push(`loop ${loop} is in no entry's code.loops and not an infra loop`);
  }
  return problems;
}

/** R1: each write route (`METHOD /url`) is an exact `code.routes` value, or an infra route with a reason. */
export function checkR1(
  routes: readonly string[],
  entries: readonly FlowEntry[],
  infraRoutes: Readonly<Record<string, string>>
): string[] {
  const covered = new Set(live(entries).flatMap((entry) => entry.code.routes ?? []));
  const problems: string[] = [];
  for (const route of routes) {
    if (route in infraRoutes) {
      if (infraRoutes[route]!.trim() === "") problems.push(`infra route ${route} needs a reason`);
    } else if (!covered.has(route)) problems.push(`write route ${route} is in no entry and not an infra route`);
  }
  return problems;
}

/** R2: GET routes that write are a hand-kept set, checked both ways. */
export function checkR2(
  getWriters: Readonly<Record<string, readonly string[]>>,
  entries: readonly FlowEntry[],
  closureWrites: (route: string) => ReadonlySet<string>
): string[] {
  const covered = new Set(live(entries).flatMap((entry) => entry.code.routes ?? []));
  const problems: string[] = [];
  for (const [route, tables] of Object.entries(getWriters)) {
    const written = closureWrites(route);
    for (const table of tables)
      if (!written.has(table)) problems.push(`GET writer ${route}: its closure does not write ${table}`);
    if (!covered.has(route)) problems.push(`GET writer ${route} is in no entry's code.routes`);
  }
  return problems;
}

/** M1: each write or propose tool is in some `code.mcpTools`. */
export function checkM1(tools: readonly string[], entries: readonly FlowEntry[]): string[] {
  const covered = new Set(live(entries).flatMap((entry) => entry.code.mcpTools ?? []));
  return tools.filter((tool) => !covered.has(tool)).map((tool) => `write tool ${tool} is in no entry's code.mcpTools`);
}

/** T1: each table is in some entry's `from` or `to` (a partition counts), or a note marks it infrastructure or dead. */
export function checkT1(
  tables: readonly string[],
  entries: readonly FlowEntry[],
  notes: readonly DatasetNote[]
): string[] {
  const touched = new Set(
    live(entries).flatMap((entry) =>
      [...entry.from, ...entry.to].flatMap((ref) => {
        const parsed = parseDatasetRef(ref);
        return parsed?.scheme === "pg" ? [parsed.name] : [];
      })
    )
  );
  const excused = new Set(
    notes.filter((note) => note.infrastructure !== undefined || note.dead !== undefined).map((note) => note.ref)
  );
  return tables
    .filter((table) => !touched.has(table) && !excused.has(`pg:${table}`))
    .map((table) => `table ${table} is in no entry's from or to and has no infrastructure or dead note`);
}

/** D1: each device has at least one entry whose probe is not `none`. */
export function checkD1(entries: readonly FlowEntry[]): string[] {
  const devices = new Set(live(entries).flatMap((entry) => (entry.device ? [entry.device] : [])));
  return [...devices]
    .filter((device) => !live(entries).some((entry) => entry.device === device && entry.health.kind !== "none"))
    .map((device) => `device ${device} has no entry with a probe`);
}

const pgBases = (refs: readonly string[]): string[] =>
  refs.flatMap((ref) => {
    const parsed = parseDatasetRef(ref);
    return parsed?.scheme === "pg" ? [parsed.name] : [];
  });

const hasCode = (entry: FlowEntry) =>
  (entry.code.paths ?? []).length + (entry.code.routes ?? []).length + (entry.code.loops ?? []).length > 0;

/** What the pipes an entry writes through are credited with. */
function pipeCredit(entry: FlowEntry, entries: readonly FlowEntry[]): Set<string> {
  const credited = new Set<string>();
  for (const pipeId of entry.via ?? []) {
    const pipe = entries.find((candidate) => candidate.id === pipeId);
    if (!pipe) continue;
    for (const table of pgBases(pipe.to)) credited.add(table);
    for (const write of pipe.incidentalWrites ?? []) credited.add(write.table);
  }
  return credited;
}

/** V1: each `pg:` table in `to` has a writer in the closure of the entry's routes, loops and paths, or in a `via` pipe. */
export function checkV1(
  entries: readonly FlowEntry[],
  closureWrites: (entry: FlowEntry) => ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  for (const entry of live(entries)) {
    if (!hasCode(entry)) continue;
    const written = closureWrites(entry);
    const viaPipe = pipeCredit(entry, entries);
    for (const table of new Set(pgBases(entry.to)))
      if (!written.has(table) && !viaPipe.has(table))
        problems.push(`${entry.id}: writes pg:${table} in no file of its closure`);
  }
  return problems;
}

/** V1-reverse: a table written in the entry's own files and routes, plus one hop, is in `to` or `incidentalWrites`. */
export function checkV1Reverse(
  entries: readonly FlowEntry[],
  nearWrites: (entry: FlowEntry) => ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  for (const entry of live(entries)) {
    if (!hasCode(entry)) continue;
    const allowed = new Set([
      ...pgBases(entry.to),
      ...(entry.incidentalWrites ?? []).map((write) => write.table),
      ...pipeCredit(entry, entries)
    ]);
    for (const table of [...nearWrites(entry)].sort())
      if (!allowed.has(table))
        problems.push(`${entry.id}: writes ${table}, which is neither in to nor in incidentalWrites`);
  }
  return problems;
}

/** An `incidentalWrites` table the entry's closure no longer writes is stale and must go. */
export function checkStaleIncidental(
  entries: readonly FlowEntry[],
  nearWrites: (entry: FlowEntry) => ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  for (const entry of live(entries)) {
    if (!hasCode(entry) || (entry.incidentalWrites ?? []).length === 0) continue;
    const written = nearWrites(entry);
    for (const { table } of entry.incidentalWrites ?? [])
      if (!written.has(table))
        problems.push(`${entry.id}: incidentalWrites lists ${table}, which its closure no longer writes`);
  }
  return problems;
}

/** V2: a reader naming `[source=s]` has the literal `"s"` in its closure, or declares `[source=*]` with a note. */
export function checkV2(entries: readonly FlowEntry[], closureText: (entry: FlowEntry) => string): string[] {
  const problems: string[] = [];
  for (const entry of live(entries)) {
    if (entry.role !== "reader" && entry.role !== "sink") continue;
    for (const ref of entry.from) {
      const source = parseDatasetRef(ref)?.filters.source;
      if (source === undefined) continue;
      if (source === "*") {
        if (!entry.value?.note) problems.push(`${entry.id}: reads [source=*] without a value.note giving the reason`);
      } else if (!closureText(entry).includes(`"${source}"`))
        problems.push(`${entry.id}: reads source ${source} but its closure never names "${source}"`);
    }
  }
  return problems;
}

export interface SurfaceEvidence {
  /** The files and text of the closure of a page's `page.tsx`. */
  pageClosure(pageFile: string): { files: readonly string[]; text: string };
  /** The text of the CLI command a manifest tool runs. */
  toolText(tool: string): string;
}

const routeNeedle = (route: string): string => {
  const url = route.slice(route.indexOf(" ") + 1);
  const cut = url.indexOf("[");
  return cut === -1 ? url : url.slice(0, cut);
};

/** V3: a reader claims a page, tool, device or external surface only with evidence in the code. */
export function checkV3(entries: readonly FlowEntry[], evidence: SurfaceEvidence): string[] {
  const problems: string[] = [];
  for (const entry of live(entries)) {
    if (entry.role !== "reader" && entry.role !== "sink") continue;
    const routes = entry.code.routes ?? [];
    for (const ref of entry.to) {
      const surface = parseSurface(ref);
      if (!surface) continue;
      if (surface.kind === "page") {
        const closure = evidence.pageClosure(surfacePageFile(ref)!);
        const proven =
          routes.some((route) => closure.text.includes(routeNeedle(route))) ||
          (entry.code.paths ?? []).some((path) => closure.files.includes(path));
        if (!proven)
          problems.push(
            `${entry.id}: ${ref} is not backed by its page closure (no route or path of the reader appears)`
          );
      } else if (surface.kind === "tool") {
        const text = evidence.toolText(surface.name!);
        if (!routes.some((route) => text.includes(routeNeedle(route))))
          problems.push(`${entry.id}: ${ref} is not backed by the tool's command (no route of the reader appears)`);
      } else if (surface.kind === "device") {
        if (!routes.some((route) => route.endsWith(` /${surface.name}`)))
          problems.push(`${entry.id}: ${ref} is not one of the reader's routes`);
      } else if (surface.kind === "external") {
        if (entry.connection !== surface.name)
          problems.push(`${entry.id}: ${ref} needs the reader's connection to be ${surface.name}`);
      }
    }
  }
  return problems;
}

/** A planned entry whose `landsAs` thing now exists must drop `planned` (design 2.6). */
export function checkPlannedLanded(
  entries: readonly FlowEntry[],
  env: { activitySources: ReadonlySet<string>; tables: ReadonlySet<string>; routes: ReadonlySet<string> }
): string[] {
  return entries
    .filter((entry) => {
      const lands = entry.planned?.landsAs;
      if (!lands) return false;
      if ("activitySource" in lands) return env.activitySources.has(lands.activitySource);
      if ("table" in lands) return env.tables.has(lands.table);
      return env.routes.has(lands.route);
    })
    .map((entry) => `${entry.id}: this has landed: drop planned`);
}
