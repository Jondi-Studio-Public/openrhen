import {
  ACTIVITY_PARTITION_TABLE,
  FLOW_ID_PATTERN,
  FLOW_TEXT_CAPS,
  flowEntrySchema,
  parseDatasetRef,
  parseSurface,
  surfacePageFile,
  type DatasetNote,
  type FlowEntry,
  type HealthProbe
} from "@openrhen/contracts/data-flow";

/**
 * The registry's staleness checks (design 3.3: S1 to S8, X1, X2) and the engine check (E1) as pure functions over a
 * registry and a description of the code it points at. Each returns the problems it found, empty when it passes, so a
 * fixture can show it failing and `registry-coverage.test.ts` runs them against the real repository.
 */

export interface CheckEnv {
  /** Tables in the schema. */
  tables: ReadonlySet<string>;
  /** Database column names of each schema table. */
  columns: ReadonlyMap<string, ReadonlySet<string>>;
  /** What is at a repo-relative path. A directory path ends with `/`. */
  pathKind(path: string): "file" | "dir" | null;
  /** Route URL (`/api/notes/[id]`) to the methods its file exports. */
  routes: ReadonlyMap<string, readonly string[]>;
  /** The worker loops (L1) and service loops (L2). */
  loops: ReadonlySet<string>;
  connections: ReadonlySet<string>;
  syncProviders: ReadonlySet<string>;
  mcpTools: ReadonlySet<string>;
  activitySources: Readonly<Record<string, { kinds: readonly string[] }>>;
}

const present = (entry: FlowEntry) => entry.planned === undefined;
const METHOD_ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const DIRECTORY_ALLOWED = /^integrations\/[^/]+\/src\/[^/]+\/$/;

/** Every entry parses against the schema (S0: not numbered in the design, but every other check relies on it). */
export function checkShape(entries: readonly FlowEntry[]): string[] {
  return entries.flatMap((entry) => {
    const parsed = flowEntrySchema.safeParse(entry);
    if (parsed.success) return [];
    const issue = parsed.error.issues[0];
    return [`${entry.id}: ${issue?.path.join(".") || "entry"} ${issue?.message ?? "is invalid"}`];
  });
}

/** S1: every `code.paths` file exists; a planned entry has no `code` but `external`. */
export function checkS1(entries: readonly FlowEntry[], env: CheckEnv): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (!present(entry)) {
      for (const key of ["paths", "routes", "loops", "mcpTools"] as const)
        if ((entry.code[key] ?? []).length > 0)
          problems.push(`${entry.id}: a planned entry has code.${key}; only code.external is allowed`);
      continue;
    }
    for (const path of entry.code.paths ?? []) {
      const kind = env.pathKind(path);
      if (kind === null) problems.push(`${entry.id}: code.paths ${path} does not exist`);
      else if (kind === "dir" && !DIRECTORY_ALLOWED.test(path))
        problems.push(`${entry.id}: code.paths ${path} is a directory; only integrations/<name>/src/<sub>/ may be`);
    }
  }
  return problems;
}

/** S2: every `code.routes` value is an existing route file exporting that method. */
export function checkS2(entries: readonly FlowEntry[], env: CheckEnv): string[] {
  const problems: string[] = [];
  for (const entry of entries.filter(present))
    for (const route of entry.code.routes ?? []) {
      if (route.includes("*")) {
        problems.push(`${entry.id}: code.routes ${route} uses a wildcard`);
        continue;
      }
      const match = METHOD_ROUTE.exec(route);
      if (!match) {
        problems.push(`${entry.id}: code.routes ${route} is not "METHOD /url"`);
        continue;
      }
      const methods = env.routes.get(match[2]!);
      if (!methods) problems.push(`${entry.id}: code.routes ${route} has no such route`);
      else if (!methods.includes(match[1]!))
        problems.push(`${entry.id}: code.routes ${route} does not export ${match[1]}`);
    }
  return problems;
}

/** S3: every `code.loops` value (and a loop trigger) is a worker or service loop. */
export function checkS3(entries: readonly FlowEntry[], env: CheckEnv): string[] {
  const problems: string[] = [];
  for (const entry of entries.filter(present)) {
    for (const loop of entry.code.loops ?? [])
      if (!env.loops.has(loop)) problems.push(`${entry.id}: code.loops ${loop} is not a known loop`);
    if (entry.trigger.kind === "loop" && !env.loops.has(entry.trigger.loop))
      problems.push(`${entry.id}: trigger loop ${entry.trigger.loop} is not a known loop`);
  }
  return problems;
}

/** S4: `connection`, `activitySource` (present entries), `syncProvider`, `mcpTools`, `via` and `feeds` all exist. */
export function checkS4(entries: readonly FlowEntry[], env: CheckEnv): string[] {
  const problems: string[] = [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.connection !== undefined && !env.connections.has(entry.connection))
      problems.push(`${entry.id}: connection ${entry.connection} is not registered`);
    if (entry.syncProvider !== undefined && !env.syncProviders.has(entry.syncProvider))
      problems.push(`${entry.id}: syncProvider ${entry.syncProvider} is not known`);
    if (present(entry) && entry.activitySource !== undefined && !(entry.activitySource in env.activitySources))
      problems.push(`${entry.id}: activitySource ${entry.activitySource} is not registered`);
    for (const tool of entry.code.mcpTools ?? [])
      if (!env.mcpTools.has(tool)) problems.push(`${entry.id}: mcp tool ${tool} is not in the manifest`);
    for (const pipe of entry.via ?? []) {
      const target = byId.get(pipe);
      if (!target) problems.push(`${entry.id}: via ${pipe} is not an entry`);
      else if (target.role !== "pipe") problems.push(`${entry.id}: via ${pipe} is not a pipe`);
    }
    for (const fed of entry.feeds ?? []) if (!byId.has(fed)) problems.push(`${entry.id}: feeds ${fed} is not an entry`);
  }
  return problems;
}

/** Whether a `pg:` name is a schema table or one a dataset note describes. */
function knownTable(name: string, notes: readonly DatasetNote[], env: CheckEnv): boolean {
  return env.tables.has(name) || notes.some((note) => note.ref === `pg:${name}`);
}

/** S5: `pg:` refs are known tables; a partition's source is registered and its kind belongs to that source. */
export function checkS5(entries: readonly FlowEntry[], notes: readonly DatasetNote[], env: CheckEnv): string[] {
  const problems: string[] = [];
  for (const note of notes) {
    const parsed = parseDatasetRef(note.ref);
    if (parsed?.scheme === "pg" && !env.tables.has(parsed.name) && note.columns === undefined)
      problems.push(`dataset note ${note.ref} is not a known table`);
  }
  for (const entry of entries.filter(present)) {
    for (const ref of [...entry.from, ...entry.to]) {
      const parsed = parseDatasetRef(ref);
      if (!parsed) {
        problems.push(`${entry.id}: ${ref} is not a dataset name`);
        continue;
      }
      if (parsed.scheme !== "pg") continue;
      if (!knownTable(parsed.name, notes, env)) {
        problems.push(`${entry.id}: ${ref} is not a known table`);
        continue;
      }
      const filters = Object.entries(parsed.filters);
      if (filters.length === 0) continue;
      if (parsed.name !== ACTIVITY_PARTITION_TABLE) {
        problems.push(`${entry.id}: ${ref} is a partition of a table that has none`);
        continue;
      }
      const bad = filters.find(([key]) => key !== "source" && key !== "kind");
      if (bad) {
        problems.push(`${entry.id}: ${ref} filters on ${bad[0]}, which is not source or kind`);
        continue;
      }
      const { source, kind } = parsed.filters;
      if (source === undefined) {
        problems.push(`${entry.id}: ${ref} filters on kind without a source`);
        continue;
      }
      if (source !== "*" && !(source in env.activitySources)) {
        problems.push(`${entry.id}: ${ref} names an unregistered activity source`);
        continue;
      }
      if (kind !== undefined && kind !== "*" && source !== "*") {
        const kinds = [...(env.activitySources[source]?.kinds ?? []), "correction"];
        if (!kinds.includes(kind)) problems.push(`${entry.id}: ${ref} names a kind ${source} does not take`);
      }
    }
    for (const write of entry.incidentalWrites ?? [])
      if (!knownTable(write.table, notes, env))
        problems.push(`${entry.id}: incidentalWrites table ${write.table} is not a known table`);
    for (const item of entry.notRead ?? [])
      if (!knownTable(item.table, notes, env))
        problems.push(`${entry.id}: notRead table ${item.table} is not a known table`);
  }
  return problems;
}

/** S6: the extensions' `amend` keys are core entry ids. */
export function checkS6(amendKeys: readonly string[], coreIds: ReadonlySet<string>): string[] {
  return amendKeys.filter((key) => !coreIds.has(key)).map((key) => `amend ${key} is not a core entry id`);
}

function probesOf(probe: HealthProbe): HealthProbe[] {
  return probe.kind === "lag" ? [...probesOf(probe.upstream), ...probesOf(probe.downstream)] : [probe];
}

/** S7: probe tables, columns and `where` keys exist (Drizzle columns, or a note's `columns` for other tables). */
export function checkS7(entries: readonly FlowEntry[], notes: readonly DatasetNote[], env: CheckEnv): string[] {
  const problems: string[] = [];
  const columnsOf = (table: string): ReadonlySet<string> | null => {
    const drizzle = env.columns.get(table);
    if (drizzle) return drizzle;
    const note = notes.find((candidate) => candidate.ref === `pg:${table}`);
    return note?.columns ? new Set(note.columns) : null;
  };
  for (const entry of entries.filter(present))
    for (const probe of probesOf(entry.health)) {
      if (probe.kind === "activity" && !(probe.source in env.activitySources))
        problems.push(`${entry.id}: probe activity source ${probe.source} is not registered`);
      if (probe.kind !== "max" && probe.kind !== "last-used" && probe.kind !== "json-stamp") continue;
      const columns = columnsOf(probe.table);
      if (columns === null) {
        problems.push(`${entry.id}: probe table ${probe.table} is not a known table`);
        continue;
      }
      const wanted: { label: string; column: string }[] =
        probe.kind === "max"
          ? [
              { label: "column", column: probe.column },
              ...Object.keys(probe.where ?? {}).map((column) => ({ label: "where key", column }))
            ]
          : probe.kind === "json-stamp"
            ? [{ label: "column", column: probe.column }]
            : [];
      for (const { label, column } of wanted)
        if (!columns.has(column)) problems.push(`${entry.id}: probe ${label} ${probe.table}.${column} does not exist`);
    }
  return problems;
}

/** S8: each surface is well formed and points at a page, tool, route or connection that exists. */
export function checkS8(entries: readonly FlowEntry[], env: CheckEnv): string[] {
  const problems: string[] = [];
  for (const entry of entries.filter(present))
    for (const ref of [...entry.from, ...entry.to].filter((candidate) => candidate.startsWith("surface:"))) {
      const surface = parseSurface(ref);
      if (!surface) {
        problems.push(`${entry.id}: ${ref} is not a surface`);
        continue;
      }
      if (surface.kind === "page") {
        const file = surfacePageFile(ref)!;
        if (env.pathKind(file) !== "file") problems.push(`${entry.id}: ${ref} has no ${file}`);
      } else if (surface.kind === "tool" && !env.mcpTools.has(surface.name!))
        problems.push(`${entry.id}: ${ref} is not an MCP tool`);
      else if (surface.kind === "device" && !env.routes.has(`/${surface.name}`))
        problems.push(`${entry.id}: ${ref} is not a route`);
      else if (surface.kind === "external" && !env.connections.has(surface.name!))
        problems.push(`${entry.id}: ${ref} is not a connection`);
    }
  return problems;
}

/** X1: ids unique and kebab-case; every overlay `data-flow-*.ts` registered; a reader's `none` probe gives a reason. */
export function checkX1(
  entries: readonly FlowEntry[],
  overlay: { overlayFiles: readonly string[]; extensionIds: readonly string[] }
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`${entry.id}: id is used twice`);
    seen.add(entry.id);
    if (!FLOW_ID_PATTERN.test(entry.id)) problems.push(`${entry.id}: id is not kebab-case`);
    if (entry.role === "reader" && present(entry) && entry.health.kind === "none" && entry.health.reason.trim() === "")
      problems.push(`${entry.id}: a reader with no probe needs a reason`);
    if (!present(entry) && entry.health.kind !== "none")
      problems.push(`${entry.id}: a planned entry must have health none`);
  }
  for (const file of overlay.overlayFiles) {
    const id = file.replace(/\.ts$/, "");
    if (!overlay.extensionIds.includes(id)) problems.push(`${file}: no extension registered with id ${id}`);
  }
  return problems;
}

/** X2: every free-text field is within its cap. */
export function checkX2(entries: readonly FlowEntry[], notes: readonly DatasetNote[]): string[] {
  const problems: string[] = [];
  const over = (owner: string, field: string, text: string | undefined, cap: number) => {
    if (text !== undefined && text.length > cap)
      problems.push(`${owner}: ${field} is ${text.length} characters; the cap is ${cap}`);
  };
  for (const entry of entries) {
    over(entry.id, "name", entry.name, FLOW_TEXT_CAPS.name);
    over(entry.id, "gives", entry.gives, FLOW_TEXT_CAPS.gives);
    over(entry.id, "value.note", entry.value?.note, FLOW_TEXT_CAPS.note);
    over(entry.id, "value.potential", entry.value?.potential, FLOW_TEXT_CAPS.potential);
    for (const write of entry.incidentalWrites ?? [])
      over(entry.id, "incidentalWrites reason", write.reason, FLOW_TEXT_CAPS.incidentalReason);
    for (const item of entry.notRead ?? [])
      over(entry.id, "notRead reason", item.reason, FLOW_TEXT_CAPS.incidentalReason);
    for (const probe of probesOf(entry.health))
      if (probe.kind === "none") over(entry.id, "health.none reason", probe.reason, FLOW_TEXT_CAPS.noneReason);
  }
  for (const note of notes) {
    over(note.ref, "label", note.label, FLOW_TEXT_CAPS.datasetLabel);
    over(note.ref, "dead", note.dead, FLOW_TEXT_CAPS.datasetDead);
    over(note.ref, "infrastructure", note.infrastructure, FLOW_TEXT_CAPS.datasetInfrastructure);
  }
  return problems;
}

/** E1: the engine reader's `from` is the plan-input list minus its `notRead`, and no blind table is a plan input. */
export function checkE1(
  entries: readonly FlowEntry[],
  planInput: readonly string[],
  blind: readonly string[]
): string[] {
  const problems: string[] = [];
  for (const table of blind)
    if (planInput.includes(table)) problems.push(`${table} is both a plan input and a blind table`);
  const engine = entries.filter(
    (entry) => present(entry) && entry.role === "reader" && entry.to.includes("surface:engine")
  );
  if (engine.length !== 1) {
    problems.push(
      engine.length === 0
        ? "no entry is the engine reader (a reader whose to is surface:engine)"
        : `${engine.length} entries claim to be the engine reader`
    );
    return problems;
  }
  const reader = engine[0]!;
  const notRead = new Set((reader.notRead ?? []).map((item) => item.table));
  const read = new Set(
    reader.from.flatMap((ref) => {
      const parsed = parseDatasetRef(ref);
      return parsed?.scheme === "pg" ? [parsed.name] : [];
    })
  );
  for (const table of notRead)
    if (!planInput.includes(table)) problems.push(`${reader.id}: notRead ${table} is not a plan input`);
  for (const table of planInput)
    if (!read.has(table) && !notRead.has(table))
      problems.push(`${reader.id}: engine reader does not read ${table}, which is a plan input and not in notRead`);
  for (const table of read)
    if (!planInput.includes(table))
      problems.push(`${reader.id}: engine reader reads ${table}, which is not a plan input`);
  return problems;
}
