import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Watch history and the Now offer log stay invisible to the planning engine: their tables are not plan inputs (so a
 * write queues no recalculation) and nothing that builds the portal state or the forecast request reads them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const WATCH_TABLES = ["watch_events", "watch_imports", "video_info"];
/**
 * The watch-history tables, the activity store (`activity_events`, its import records and per-source settings), the
 * tables that support them (saved keys, the YouTube quota counter), and the Now offer log: none feeds the plan. The
 * offer log is write-only for planning: `plan-forecast-runtime.ts` appends an `offered` row through
 * `offer-log/offer-log.ts`, which lives outside `planning/`, and no planning or engine file names the table.
 */
const ACTIVITY_TABLES = [
  "activity_events",
  "activity_imports",
  "activity_source_state",
  "derived_lineage",
  "extractor_state"
];
const BLIND_TABLES = [...WATCH_TABLES, ...ACTIVITY_TABLES, "app_secrets", "youtube_quota_use", "offer_log"];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".vinext",
  "coverage",
  "drizzle",
  ".git"
]);

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sources(path);
    if (!/\.(?:ts|tsx|mjs)$/.test(entry.name) || /\.test\.(?:ts|tsx|mjs)$/.test(entry.name)) return [];
    return [{ path, text: readFileSync(path, "utf8") }];
  });
}

/**
 * Every non-test source file that is allowed to name one of those tables, and nothing else may: the stores that own
 * them, the saved-key reader, the schema and the backup lists. A new file that touches them has to be added here on
 * purpose, which is the moment to ask whether it should be a plan input.
 */
const MAY_NAME_BLIND_TABLES = new Set([
  "portal/server/persistence/postgres/watch-history-store.ts",
  "portal/server/persistence/postgres/video-lengths-store.ts",
  "portal/server/persistence/postgres/activity-store.ts",
  "portal/server/persistence/postgres/derived-lineage-store.ts",
  "portal/server/persistence/postgres/derived-scan-store.ts",
  "portal/server/persistence/postgres/derived-write-store.ts",
  "portal/server/persistence/postgres/activity-retention-store.ts",
  "portal/server/persistence/postgres/derived-source-gone-store.ts",
  "portal/server/persistence/postgres/eval-report-store.ts",
  "portal/server/persistence/postgres/extractor-state-store.ts",
  "portal/server/persistence/postgres/app-secrets-store.ts",
  "portal/server/secrets/read-secret.ts",
  "platform/database/src/schema/core.ts",
  "platform/database/src/operations/backup-run.ts",
  "platform/database/src/operations/restore-run.ts",
  "platform/database/src/operations/backup-format.ts",
  "platform/database/src/operations/private/legacy-backups.ts",
  "platform/database/src/offer-log/offer-log.ts"
]);

describe("watch history is blind to the engine", () => {
  it("is absent from PLAN_INPUT_TABLES", () => {
    const registry = readFileSync(join(repo, "scripts", "repository", "write-path-registry.mjs"), "utf8");
    const list = /export const PLAN_INPUT_TABLES = \[([\s\S]*?)\]/.exec(registry)?.[1];
    expect(list).toBeTruthy();
    for (const table of BLIND_TABLES) expect(list).not.toContain(`"${table}"`);
    // The list is really the one that guards plan inputs: it still names a table the engine reads.
    expect(list).toContain('"actions"');
  });

  it("is never read by readPortalState or buildPlanForecastRequest", () => {
    const files = [
      {
        path: "state-read.ts",
        text: readFileSync(join(repo, "portal", "server", "persistence", "postgres", "state-read.ts"), "utf8")
      },
      ...sources(join(repo, "portal", "server", "persistence", "postgres", "readers")),
      ...sources(join(repo, "platform", "database", "src", "planning"))
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files)
      for (const table of BLIND_TABLES) expect(file.text, `${file.path} names ${table}`).not.toContain(table);
  });

  it("is never read by the engine, and retention and planning only append through the helper", () => {
    const engine = sources(join(repo, "engine"));
    expect(engine.length).toBeGreaterThan(20);
    for (const file of engine) {
      expect(file.text, `${file.path} names the offer log`).not.toContain("offer_log");
      expect(file.text, `${file.path} imports the offer log helper`).not.toContain("offer-log");
    }
    const planning = sources(join(repo, "platform", "database", "src", "planning"));
    const importing = planning
      .filter((file) => file.text.includes("offer-log"))
      .map((file) => relative(repo, file.path).split(sep).join("/"));
    // The one planning file that touches the log appends an `offered` row; it imports the writer, never a reader or the table.
    expect(importing).toEqual(["platform/database/src/planning/plan-forecast-runtime.ts"]);
    const runtime = planning.find((file) => file.path.endsWith("plan-forecast-runtime.ts"))!.text;
    const imported = /import \{([^}]*)\} from "\.\.\/offer-log\/offer-log\.js"/.exec(runtime)?.[1] ?? "";
    expect(
      imported
        .split(",")
        .map((name) => name.trim().replace(/^type /, ""))
        .sort()
    ).toEqual(["OFFER_LOG_TOP_CANDIDATES", "OfferedCandidate", "recordOffered"]);
    const retention = planning.find((file) => file.path.endsWith("plan-retention.ts"))!.text;
    expect(retention).not.toMatch(/offer[-_]log/);
  });

  it("is named by no other non-test source in the repository", () => {
    const roots = ["engine", "portal", "platform", "integrations", "tools", "scripts"];
    const files = roots.flatMap((name) => sources(join(repo, name)));
    expect(files.length).toBeGreaterThan(500);
    const naming = files
      .filter((file) => BLIND_TABLES.some((table) => file.text.includes(table)))
      .map((file) => relative(repo, file.path).split(sep).join("/"))
      .sort();
    expect(naming.filter((path) => !MAY_NAME_BLIND_TABLES.has(path))).toEqual([]);
    // The allowance list does not rot: each file on it still names a table.
    expect(naming).toEqual([...MAY_NAME_BLIND_TABLES].sort());
  });

  it("keeps the physiology module and every symbol it exports out of the engine", () => {
    // `@openrhen/contracts` is a barrel, so naming a symbol is the same as importing the module. The symbols are listed
    // here on purpose: a new export of activity-physiology.ts has to be added to this list in the same change.
    const SYMBOLS = [
      "activity-physiology",
      "PHYSIOLOGY_",
      "canonicalPhysiologyKey",
      "describePhysiologyProblem",
      "physiologyJsonSchema",
      "PhysiologyEventInput",
      "withheldActivitySources",
      "activityHealthSources",
      "ACTIVITY_HEALTH_"
    ];
    const exported = [
      ...readFileSync(join(repo, "platform", "contracts", "src", "activity-physiology.ts"), "utf8").matchAll(
        /^export (?:const|function|interface|type) (\w+)/gm
      )
    ].map((match) => match[1]!);
    expect(exported.length).toBeGreaterThan(10);
    // Every export is covered by a listed symbol (a prefix or the whole name).
    for (const name of exported)
      expect(
        SYMBOLS.some((symbol) => name.startsWith(symbol) || name === symbol),
        name
      ).toBe(true);
    const engine = sources(join(repo, "engine"));
    expect(engine.length).toBeGreaterThan(20);
    for (const file of engine)
      for (const symbol of SYMBOLS) expect(file.text, `${file.path} names ${symbol}`).not.toContain(symbol);
    // The module itself names none of the blind tables, so the table test above lets it stand.
    const module = readFileSync(join(repo, "platform", "contracts", "src", "activity-physiology.ts"), "utf8");
    for (const table of BLIND_TABLES) expect(module).not.toContain(table);
  });

  it("keeps the activity store's code and drizzle names out of every file but its own routes and store", () => {
    // snake_case names are covered above; this catches the module and the drizzle table objects, which a file could
    // import without ever writing a table name.
    const NAMES = [/activity-store(?!\.md)/, /\bactivityEvents\b/, /\bactivityImports\b/, /\bactivitySourceState\b/];
    const MAY_USE_ACTIVITY_CODE = new Set([
      "portal/server/persistence/postgres/activity-store.ts",
      "portal/server/activity-ingest.ts",
      "portal/app/api/activity-events/route.ts",
      "portal/app/api/activity-events/summary/route.ts",
      "portal/app/api/activity-imports/route.ts",
      "portal/app/api/activity-imports/[id]/route.ts",
      "portal/app/api/activity-sources/[source]/route.ts",
      "portal/app/api/activity-sources/[source]/events/route.ts",
      "platform/database/src/schema/core.ts"
    ]);
    const roots = ["engine", "portal", "platform", "integrations", "tools", "scripts"];
    const files = roots.flatMap((name) => sources(join(repo, name)));
    const using = files
      .filter((file) => NAMES.some((pattern) => pattern.test(file.text)))
      .map((file) => relative(repo, file.path).split(sep).join("/"))
      .sort();
    expect(using.filter((path) => !MAY_USE_ACTIVITY_CODE.has(path))).toEqual([]);
    // The allowance does not rot: each file on it still uses the activity code.
    expect(using).toEqual([...MAY_USE_ACTIVITY_CODE].sort());
  });
});
