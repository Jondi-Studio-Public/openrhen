import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@openrhen/database/schema";
import {
  ACTIVITY_SOURCES,
  MCP_CORE_TOOL_MANIFEST,
  MCP_TOOL_MANIFEST,
  connectionRegistry,
  doctorSyncCadence,
  withoutContractsExtensions
} from "@openrhen/contracts";
import {
  BLIND_TABLES,
  CORE_FLOW_ENTRIES,
  PLAN_INPUT_TABLES,
  dataFlowGraph,
  dataFlowRegistry,
  type FlowEntry
} from "@openrhen/contracts/data-flow";
import {
  checkA1,
  checkC1,
  checkD1,
  checkL1,
  checkM1,
  checkP1,
  checkPlannedLanded,
  checkR1,
  checkR2,
  checkT1,
  checkV1,
  checkV1Reverse,
  checkV2,
  checkV3
} from "./registry-coverage-rules";
import {
  exportedMethods,
  loopStartFiles,
  resolveClosure,
  serviceLoopNames,
  tablesWrittenIn,
  workerLoopNames,
  type StopReason
} from "./enumerate";
import {
  checkE1,
  checkS1,
  checkS2,
  checkS3,
  checkS4,
  checkS5,
  checkS6,
  checkS7,
  checkS8,
  checkShape,
  checkX1,
  checkX2,
  type CheckEnv
} from "./registry-checks";

/**
 * Holds the data-flow registry to the code it describes (design 3.3, 3.4): every entry points at something that
 * exists, the engine reader matches the plan-input list, and the closure walker measures what each route and loop
 * reaches. PR A1 runs the staleness checks over the seed entries; PR A2 adds the entries and the coverage rules.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const posix = (value: string) => value.split(sep).join("/");

const SKIPPED = new Set(["node_modules", "dist", "build", ".next", ".vinext", "coverage", "drizzle", ".git"]);
function sourceFiles(directory: string): string[] {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sourceFiles(path);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
const read = (file: string) => readFileSync(join(root, file), "utf8");

// The scripts are plain .mjs that cannot be imported across the package boundary, so load them the way check-structure does.
const { listRoutes } = (await import(
  /* @vite-ignore */ pathToFileURL(resolve(root, "scripts/repository/addon-routes.mjs")).href
)) as {
  listRoutes(root: string): { url: string; file: string; addon: boolean }[];
};

// Tables come from the schema's own exports: contracts depends on neither drizzle nor the database, so they are passed in.
const drizzleTables = Object.entries(schema as Record<string, unknown>).flatMap(([ident, value]): [string, Table][] =>
  is(value, Table) ? [[ident, value]] : []
);
const tableNames = new Set(drizzleTables.map(([, table]) => getTableName(table)));
const drizzleNames = new Map(drizzleTables.map(([ident, table]) => [ident, getTableName(table)]));
const columns = new Map(
  drizzleTables.map(([, table]) => [
    getTableName(table),
    new Set(Object.values(getTableColumns(table)).map((column) => column.name))
  ])
);

const routeFiles = listRoutes(root).filter((route) => route.file.endsWith("route.ts"));
const routes = new Map(routeFiles.map((route) => [route.url, exportedMethods(read(route.file))]));

const workerSources = sourceFiles("engine/worker/src");
const serviceSources = ["integrations", "contributors"].flatMap((group) =>
  existsSync(join(root, group))
    ? readdirSync(join(root, group)).flatMap((name) => sourceFiles(`${group}/${name}/src`))
    : []
);
const loops = new Set([
  ...workerLoopNames(read("engine/worker/src/main.ts"), workerSources.map(read)),
  ...serviceLoopNames(serviceSources.map(read))
]);

const connections = new Set(
  connectionRegistry()
    .map((manifest) => manifest.id)
    .filter((id) => !id.startsWith("example_"))
);
const env: CheckEnv = {
  tables: tableNames,
  columns,
  pathKind: (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return null;
    return statSync(absolute).isDirectory() ? "dir" : "file";
  },
  routes,
  loops,
  connections,
  syncProviders: new Set([...Object.keys(doctorSyncCadence()), ...connections]),
  mcpTools: new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name)),
  activitySources: ACTIVITY_SOURCES
};

const registry = dataFlowRegistry();
const coreIds = new Set(CORE_FLOW_ENTRIES.map((entry) => entry.id));
const overlayFiles = existsSync(join(root, "platform/contracts/src/private"))
  ? readdirSync(join(root, "platform/contracts/src/private")).filter((name) => /^data-flow-.*\.ts$/.test(name))
  : [];

describe("the data-flow registry is current", () => {
  it("has the loops it points at, so S3 means something", () => {
    expect(loops.has("plan-forecast-jobs")).toBe(true);
    expect(loops.size).toBeGreaterThan(8);
  });

  it("parses against the schema", () => expect(checkShape(registry.entries)).toEqual([]));
  it("S1: every path exists", () => expect(checkS1(registry.entries, env)).toEqual([]));
  it("S2: every route exists and exports its method", () => expect(checkS2(registry.entries, env)).toEqual([]));
  it("S3: every loop exists", () => expect(checkS3(registry.entries, env)).toEqual([]));
  it("S4: connections, sources, providers, tools, pipes and feeds exist", () =>
    expect(checkS4(registry.entries, env)).toEqual([]));
  it("S5: datasets name known tables and valid partitions", () =>
    expect(checkS5(registry.entries, registry.datasets, env)).toEqual([]));
  it("S6: amend keys are core entry ids", () => expect(checkS6(registry.amendKeys, coreIds)).toEqual([]));
  it("S7: probes name tables and columns that exist", () =>
    expect(checkS7(registry.entries, registry.datasets, env)).toEqual([]));
  it("S8: surfaces point at pages, tools, routes and connections that exist", () =>
    expect(checkS8(registry.entries, env)).toEqual([]));
  it("X1: ids are unique and every overlay file is registered", () =>
    expect(checkX1(registry.entries, { overlayFiles, extensionIds: registry.extensionIds })).toEqual([]));
  it("X2: free text is within its caps", () => expect(checkX2(registry.entries, registry.datasets)).toEqual([]));
  it("E1: the engine reader reads the plan-input list minus its notRead", () =>
    expect(checkE1(registry.entries, PLAN_INPUT_TABLES, BLIND_TABLES)).toEqual([]));

  it("builds a graph over the schema's own tables", () => {
    const graph = dataFlowGraph([...tableNames]);
    expect(graph.reach("youtube-watch-history").map((reach) => reach.surface)).toEqual(["surface:page/review"]);
    expect(graph.reach("engine-plan-input")).toEqual([]);
  });
});

/** Modules the walker reaches but does not scan (design 3.4). Writes in a pipe are credited to the pipe. */
function stops(entries: readonly FlowEntry[]): Map<string, StopReason> {
  const map = new Map<string, StopReason>();
  for (const entry of entries)
    if (entry.role === "pipe") for (const path of entry.code.paths ?? []) map.set(path, "pipe");
  for (const path of [
    "portal/server/persistence/postgres/sql-pool.ts",
    "portal/server/logging.ts",
    "portal/server/owner-auth.ts",
    "portal/server/agent-token-store.ts",
    "portal/server/mcp-access-tokens.ts",
    "portal/server/persistence/postgres/planning-evidence.ts",
    // User bootstrap seeds the owner row and starting subjects; every request path calls it, none is about that data.
    "portal/server/persistence/postgres/ensure-user.ts",
    "portal/server/runtime-env.ts",
    // The schema defines tables; it writes none.
    "platform/database/src/schema/core.ts"
  ])
    map.set(path, "infra");
  const lock = join(root, ".sync-core.json");
  if (existsSync(lock)) {
    const overlay = (JSON.parse(readFileSync(lock, "utf8")) as { overlayFiles?: string[] }).overlayFiles ?? [];
    for (const path of overlay) map.set(path, "overlay");
  }
  return map;
}

describe("the closure walker over the real repository", () => {
  const stopMap = stops(registry.entries);
  const measure = (starts: string[]) => {
    const closure = resolveClosure(starts, { root, stops: stopMap });
    const written = new Set<string>();
    for (const file of closure.files)
      for (const table of tablesWrittenIn(read(file), tableNames, drizzleNames)) written.add(table);
    return { closure, written };
  };

  it("credits GET /api/device/now with the offer log, through the database barrel to its defining module", () => {
    // The chain the design names: the route calls device-shown, which calls offer-log-writer, which calls recordShown.
    const chain = measure(["portal/server/device/device-shown.ts"]);
    expect([...chain.written]).toEqual(["offer_log"]);
    expect(chain.closure.files).toContain("platform/database/src/offer-log/offer-log.ts");
    // recordShown leads to offer-log.ts only, not to the barrel's other modules.
    expect(chain.closure.files).not.toContain("platform/database/src/index.ts");
    expect(chain.closure.files).not.toContain("platform/database/src/planning/plan-forecast-runtime.ts");
    expect([...measure(["portal/app/api/device/now/route.ts"]).written]).toContain("offer_log");
  });

  it("measures the tables every route and loop reaches, so PR A2 starts from known numbers", () => {
    const rows: { start: string; files: number; tables: string[]; truncated: number }[] = [];
    for (const route of routeFiles) {
      const methods = routes.get(route.url) ?? [];
      const writing = methods.filter((method) => method !== "GET");
      for (const method of writing.length > 0 ? writing : methods.slice(0, 1)) {
        const { closure, written } = measure([route.file]);
        rows.push({
          start: `${method} ${route.url}`,
          files: closure.files.length,
          tables: [...written].sort(),
          truncated: closure.truncated.length
        });
      }
    }
    for (const loop of [...loops].sort()) {
      const starts = loopStartFiles("engine/worker/src/main.ts", loop, { root });
      if (starts.length === 0) continue;
      const { closure, written } = measure(starts);
      rows.push({
        start: `loop ${loop}`,
        files: closure.files.length,
        tables: [...written].sort(),
        truncated: closure.truncated.length
      });
    }
    expect(rows.length).toBeGreaterThan(50);
    const widest = [...rows].sort((a, b) => b.tables.length - a.tables.length).slice(0, 15);
    console.info(
      [
        `closure measurement: ${rows.length} starts, ${rows.filter((r) => r.tables.length > 0).length} reach a write`,
        ...widest.map(
          (row) =>
            `  ${row.start}: ${row.tables.length} tables in ${row.files} files${row.truncated ? ` (${row.truncated} cut at depth)` : ""}`
        )
      ].join("\n")
    );
    // The walker is only measuring something if the routes it starts from are real files.
    expect(relative(root, resolve(root, routeFiles[0]!.file))).not.toMatch(/^\.\./);
    expect(posix(routeFiles[0]!.file)).toMatch(/^portal\/app\//);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// PR A2: coverage of core-owned entry points, and the write and surface evidence rules.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Overlay-owned entry points are exempt until the extension's own entries cover them: the composed tree's
 * `.sync-core.json` `overlayFiles`, every `private/` seam folder, and the runtime registrations (tables in a registered
 * group, extension connection manifests and tools). Nothing here changes in this repository alone.
 */
const lockFile = join(root, ".sync-core.json");
const overlayFileSet = new Set<string>(
  existsSync(lockFile)
    ? ((JSON.parse(readFileSync(lockFile, "utf8")) as { overlayFiles?: string[] }).overlayFiles ?? [])
    : []
);
const isCoreFile = (file: string) => !overlayFileSet.has(file) && !/(?:^|\/)private\//.test(file);

const coreTableIdents = new Set(
  [...read("platform/database/src/schema/core.ts").matchAll(/export const (\w+) = pgTable\(/g)].map(
    (match) => match[1]!
  )
);
const coreTables = [...drizzleNames.entries()].filter(([ident]) => coreTableIdents.has(ident)).map(([, name]) => name);
// The calendar feed is a core connection that registers outside the built-in list, so the core-only view omits it.
const coreConnections = [
  ...withoutContractsExtensions(() => connectionRegistry().map((manifest) => manifest.id)),
  "calendar_feed"
].filter((id, index, all) => !id.startsWith("example_") && all.indexOf(id) === index);
const coreWriteTools = MCP_CORE_TOOL_MANIFEST.filter((tool) =>
  tool.scopes.some((scope) => /^(?:write|propose):/.test(scope))
).map((tool) => tool.name);
const coreWorkerLoops = workerLoopNames(read("engine/worker/src/main.ts"), workerSources.filter(isCoreFile).map(read));
const coreServiceLoops = serviceLoopNames(serviceSources.filter(isCoreFile).map(read));
const coreWriteRoutes = routeFiles
  .filter((route) => isCoreFile(route.file))
  .flatMap((route) =>
    (routes.get(route.url) ?? []).filter((method) => method !== "GET").map((method) => `${method} ${route.url}`)
  );
const parserFiles = [
  ...sourceFiles("integrations/activity-importers/src/parsers"),
  ...sourceFiles("portal/server/imports").filter((file) =>
    /(?:-parser|-extractor|\/deliverable-source-file)\.ts$/.test(file)
  )
].filter(isCoreFile);

/** Write routes that are not data entry points: sign-in, tokens, the MCP endpoint and connection probes. */
const INFRA_ROUTES: Record<string, string> = {
  "POST /mcp": "the MCP transport; its tools are listed on the agent entry",
  "POST /oauth/authorize": "remote agent sign-in",
  "POST /oauth/register": "remote agent sign-in",
  "POST /oauth/token": "remote agent sign-in",
  "POST /api/owner/credentials": "owner sign-in credentials",
  "DELETE /api/owner/credentials/[id]": "owner sign-in credentials",
  "POST /api/owner/enroll": "owner sign-in credentials",
  "POST /api/owner/signout": "owner sign-in credentials",
  "POST /api/agent-tokens": "agent credential management",
  "PATCH /api/agent-tokens/[id]": "agent credential management",
  "DELETE /api/agent-tokens/[id]": "agent credential management",
  "POST /api/connections/status": "a connection probe; it records call counts only"
};
/** Worker loops that are bookkeeping, not data entry points. */
const INFRA_LOOPS: Record<string, string> = {
  "reclaim-plan-forecast-jobs": "frees the claim on a dead recalculation job",
  "prune-planning-evidence": "deletes old change-ledger rows"
};
/** GET routes that write, kept by hand and checked both ways (R2). A new one is not caught automatically. */
const GET_WRITERS: Record<string, string[]> = { "GET /api/device/now": ["offer_log"] };

const stopMapAll = stops(registry.entries);
const routeFileByUrl = new Map(routeFiles.map((route) => [route.url, route.file]));
const writesIn = (closure: { files: string[] }) => {
  const written = new Set<string>();
  for (const file of closure.files)
    for (const table of tablesWrittenIn(read(file), tableNames, drizzleNames)) written.add(table);
  return written;
};

function startsOf(entry: FlowEntry): string[] {
  const fromRoutes = (entry.code.routes ?? []).flatMap((route) => {
    const file = routeFileByUrl.get(route.slice(route.indexOf(" ") + 1));
    return file ? [file] : [];
  });
  const fromLoops = (entry.code.loops ?? []).flatMap((loop) =>
    loopStartFiles("engine/worker/src/main.ts", loop, { root })
  );
  return [...fromRoutes, ...fromLoops, ...(entry.code.paths ?? [])];
}
/** The walker stops at pipe modules; an entry's own paths are still scanned, so a pipe sees its own writes. */
function stopsFor(entry: FlowEntry): Map<string, StopReason> {
  const own = new Set(entry.code.paths ?? []);
  return new Map([...stopMapAll].filter(([path]) => !own.has(path)));
}
const memo = <T>(compute: (entry: FlowEntry) => T) => {
  const cache = new Map<string, T>();
  return (entry: FlowEntry): T => {
    if (!cache.has(entry.id)) cache.set(entry.id, compute(entry));
    return cache.get(entry.id)!;
  };
};
const closureOf = memo((entry) => resolveClosure(startsOf(entry), { root, stops: stopsFor(entry) }));
const closureWrites = (entry: FlowEntry) => writesIn(closureOf(entry));
/**
 * V1-reverse looks at the entry's own files and the routes that can write, plus one resolved hop. A GET handler is left
 * out unless it is a known GET writer (R2). A reader or sink is held to its own paths only: its routes and loop are
 * shared with the entries that write, and say nothing about what the reader does.
 */
const nearWrites = memo((entry) => {
  const reads = entry.role === "reader" || entry.role === "sink";
  const routes = (entry.code.routes ?? []).filter((route) => !route.startsWith("GET ") || route in GET_WRITERS);
  const own = reads ? { paths: entry.code.paths ?? [] } : { ...entry.code, routes };
  return writesIn(
    resolveClosure(startsOf({ ...entry, code: own }), { root, stops: stopsFor(entry), maxDepth: reads ? 0 : 1 })
  );
});
const closureText = (entry: FlowEntry) => closureOf(entry).files.map(read).join("\n");

const pageCache = new Map<string, { files: string[]; text: string }>();
const evidence = {
  pageClosure(pageFile: string) {
    if (!pageCache.has(pageFile)) {
      const closure = resolveClosure([pageFile], { root, stops: stopMapAll });
      pageCache.set(pageFile, { files: closure.files, text: closure.files.map(read).join("\n") });
    }
    return pageCache.get(pageFile)!;
  },
  toolText(tool: string) {
    const command = MCP_CORE_TOOL_MANIFEST.find((candidate) => candidate.name === tool)?.command;
    const file = command ? `tools/cli/src/commands/${command}.ts` : "";
    return file && existsSync(join(root, file)) ? read(file) : "";
  }
};

/** Every rule, run over a list of entries; the entries a rule would flag for the whole tree are the caller's concern. */
function allProblems(entries: readonly FlowEntry[]): string[] {
  const getWriterWrites = (route: string) => {
    const file = routeFileByUrl.get(route.slice(route.indexOf(" ") + 1));
    return file ? writesIn(resolveClosure([file], { root, stops: stopMapAll })) : new Set<string>();
  };
  return [
    ...checkShape(entries),
    ...checkS1(entries, env),
    ...checkS2(entries, env),
    ...checkS3(entries, env),
    ...checkS4(entries, env),
    ...checkS5(entries, registry.datasets, env),
    ...checkS7(entries, registry.datasets, env),
    ...checkS8(entries, env),
    ...checkX1(entries, { overlayFiles, extensionIds: registry.extensionIds }),
    ...checkX2(entries, registry.datasets),
    ...checkE1(entries, PLAN_INPUT_TABLES, BLIND_TABLES),
    ...checkA1(Object.keys(ACTIVITY_SOURCES), entries),
    ...checkP1(parserFiles, entries),
    ...checkC1(coreConnections, entries),
    ...checkL1([...coreWorkerLoops, ...coreServiceLoops], entries, INFRA_LOOPS),
    ...checkR1(coreWriteRoutes, entries, INFRA_ROUTES),
    ...checkR2(GET_WRITERS, entries, getWriterWrites),
    ...checkM1(coreWriteTools, entries),
    ...checkT1(coreTables, entries, registry.datasets),
    ...checkD1(entries),
    ...checkV1(entries, closureWrites),
    ...checkV1Reverse(entries, nearWrites),
    ...checkV2(entries, closureText),
    ...checkV3(entries, evidence)
  ];
}

describe("coverage of core entry points (PR A2)", () => {
  const core = registry.entries.filter((entry) => entry.owner === "core");
  it("has no problem anywhere in the core entries", () => expect(allProblems(core)).toEqual([]));
  it("A1: every activity source has an entry", () => expect(checkA1(Object.keys(ACTIVITY_SOURCES), core)).toEqual([]));
  it("P1: every parser and extractor file is in an entry", () => {
    expect(parserFiles.length).toBeGreaterThanOrEqual(15);
    expect(checkP1(parserFiles, core)).toEqual([]);
  });
  it("C1: every connection is some entry's", () => expect(checkC1(coreConnections, core)).toEqual([]));
  it("L1/L2: every loop is an entry's or infrastructure", () =>
    expect(checkL1([...coreWorkerLoops, ...coreServiceLoops], core, INFRA_LOOPS)).toEqual([]));
  it("R1: every write route is an entry's or infrastructure", () => {
    expect(coreWriteRoutes.length).toBeGreaterThan(80);
    expect(checkR1(coreWriteRoutes, core, INFRA_ROUTES)).toEqual([]);
  });
  it("R2: GET writers are in an entry and write what they say", () =>
    expect(
      checkR2(GET_WRITERS, core, (route) =>
        writesIn(resolveClosure([routeFileByUrl.get(route.split(" ")[1]!)!], { root, stops: stopMapAll }))
      )
    ).toEqual([]));
  it("M1: every write tool is an entry's", () => {
    expect(coreWriteTools.length).toBeGreaterThan(25);
    expect(checkM1(coreWriteTools, core)).toEqual([]);
  });
  it("T1: every table is on an edge or noted", () => expect(checkT1(coreTables, core, registry.datasets)).toEqual([]));
  it("D1: every device has a probe", () => expect(checkD1(core)).toEqual([]));
  it("keeps planned entries planned only until they land", () =>
    expect(
      checkPlannedLanded(core, {
        activitySources: new Set(Object.keys(ACTIVITY_SOURCES)),
        tables: tableNames,
        routes: new Set([...routes].flatMap(([url, methods]) => methods.map((method) => `${method} ${url}`)))
      })
    ).toEqual([]));

  describe("the 2.5 acceptance list, core only", () => {
    const graph = withoutContractsExtensions(() => dataFlowGraph(coreTables));
    const unused = graph.unused();
    const bucket = (name: "unused" | "nothing-sends") =>
      unused.entries
        .filter((item) => item.bucket === name)
        .map((item) => graph.entries.find((entry) => entry.id === item.id)?.activitySource ?? item.id)
        .sort();
    it("lists the eleven archive sources as collected and unused", () =>
      expect(bucket("unused")).toEqual(
        [
          "chrome-takeout",
          "google-activity",
          "maps-places",
          "fit",
          "timeline",
          "google-chat",
          "google-access-log",
          "google-photos",
          "spotify",
          "discord-package",
          "apple-health"
        ].sort()
      ));
    it("accepts the sources nothing sends", () =>
      expect(bucket("nothing-sends")).toEqual(
        ["iphone-shortcuts", "iphone-health", "rhen-watch", "steam", "weather", "gmail"].sort()
      ));
    it("reports offer_log, forecast_snapshots and place_reference_photo as unused tables and photo_checkin_stage as dead", () => {
      for (const table of ["offer_log", "forecast_snapshots", "place_reference_photo"]) {
        expect(unused.datasets).toContain(`pg:${table}`);
      }
      expect(unused.dead).toEqual(["pg:photo_checkin_stage"]);
    });
    it("counts youtube-watch-history as used, through the review page", () => {
      expect(unused.entries.map((item) => item.id)).not.toContain("youtube-watch-history");
      expect(graph.reach("youtube-watch-history").map((r) => r.surface)).toContain("surface:page/review");
    });
    it("shows E-1's desired and deferred tables as blind in fact", () =>
      expect(graph.engineUse("portal-plan-edits").blindInFact).toEqual([
        "daily_plan_deferred_actions",
        "daily_plan_desired_actions"
      ]));
  });

  it("keeps the data pages claimed by a reader", () => {
    const claimed = new Set(core.flatMap((entry) => entry.to.filter((ref) => ref.startsWith("surface:page/"))));
    for (const page of ["inbox", "photo-checkins", "map", "reports", "doctor", "review", "deliverables"]) {
      expect([page, claimed.has(`surface:page/${page}`) || claimed.has(`surface:page/inbox/${page}`)]).toEqual([
        page,
        true
      ]);
    }
  });

  it("fails a rule when any present entry is removed", () => {
    // Entries whose removal another test catches, not a coverage rule.
    const CAUGHT_ELSEWHERE: Record<string, string> = {
      "eval-report": "the acceptance test: derived rows stay unused without a value reader",
      "rest-activity-read": "the acceptance test: pass-through reads never make a source used",
      "backup-run": "the acceptance test: pass-through reads never make a table used",
      "watch-history-panel": "the acceptance test: youtube-watch-history stays used through the review page",
      "inbox-view": "the data pages test",
      "photo-checkins-view": "the data pages test",
      "plan-map-view": "the data pages test",
      "snapshots-view": "the data pages test",
      "doctor-view": "the data pages test",
      "agent-review-view": "the data pages test",
      "deliverables-view": "the data pages test"
    };
    const survivors = core
      .filter((entry) => entry.planned === undefined && !(entry.id in CAUGHT_ELSEWHERE))
      .filter((entry) => allProblems(core.filter((other) => other.id !== entry.id)).length === 0)
      .map((entry) => entry.id);
    expect(survivors).toEqual([]);
  }, 600_000);
});
