import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Table, getTableColumns, getTableName, is } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@openrhen/database/schema";
import { ACTIVITY_SOURCES, MCP_TOOL_MANIFEST, connectionRegistry, doctorSyncCadence } from "@openrhen/contracts";
import {
  BLIND_TABLES,
  CORE_FLOW_ENTRIES,
  PLAN_INPUT_TABLES,
  dataFlowGraph,
  dataFlowRegistry,
  type FlowEntry
} from "@openrhen/contracts/data-flow";
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
const { listRoutes } = (await import(pathToFileURL(resolve(root, "scripts/repository/addon-routes.mjs")).href)) as {
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
