import {
  ACTIVITY_MESSAGE_FAMILY,
  activitySourceEntry,
  coverageScopeRequiredFor,
  doctorSyncCadence,
  type DoctorSourceInput,
  type DoctorSourcesSlice
} from "@openrhen/contracts";
import { dataFlowGraph, dataFlowRegistry, type FlowEntry } from "@openrhen/contracts/data-flow";
import { log } from "@/server/logging";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { readHealth } from "./health-reader";
import { SCHEMA_TABLES } from "./schema-tables";

/**
 * The doctor's view of the data-flow registry (design 4.7): the health reader's answer for every present entry joined
 * with what the registry's graph says about it (does the engine read it, does anything use it) and the newest file
 * import of each source. It only SELECTs, through the health reader's bounded probe connection, so the doctor stays
 * read-only. When the probes cannot be read at all it says so in `unavailable` and the doctor lists the source
 * checks as not run, rather than failing the whole report.
 */

const DAY_MS = 86_400_000;
const IMPORT_WINDOW_DAYS = 30;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The sync provider a calendar-style check already judges, so the entry keeps `sync_late` and `sync_failing`. */
function syncProviderOf(entry: FlowEntry): string | undefined {
  if (entry.syncProvider !== undefined) return entry.syncProvider;
  return entry.health.kind === "sync-runs" || entry.health.kind === "sync-status" ? entry.health.provider : undefined;
}

async function latestImports(
  sql: Sql,
  now: Date,
  owner: string
): Promise<Map<string, { status: string; at: string; skipped: number }>> {
  const out = new Map<string, { status: string; at: string; skipped: number }>();
  const rows = await sql<
    { provider: string; status: string; started_at: Date; summary: Record<string, unknown> | null }[]
  >`
    SELECT DISTINCT ON (provider) provider, status, started_at, summary FROM integration_sync_runs
    WHERE user_id = ${owner} AND provider LIKE 'import:%'
      AND started_at > ${new Date(now.getTime() - IMPORT_WINDOW_DAYS * DAY_MS)}
    ORDER BY provider, started_at DESC`;
  for (const row of rows)
    out.set(row.provider.slice("import:".length), {
      status: row.status,
      at: row.started_at.toISOString(),
      skipped: count(row.summary?.skipped) + count(row.summary?.rejected)
    });
  return out;
}

/** A message source whose messages can change the plan: flagged on the entry, or of the message family. */
const changesPlan = (entry: FlowEntry) =>
  entry.changesPlan === true ||
  (entry.activitySource !== undefined && activitySourceEntry(entry.activitySource)?.family === ACTIVITY_MESSAGE_FAMILY);

export async function readSourcesSlice(sql: Sql, now: Date, userId: string): Promise<DoctorSourcesSlice> {
  const startedAt = Date.now();
  try {
    const registry = dataFlowRegistry();
    const graph = dataFlowGraph(SCHEMA_TABLES, {}, registry);
    const present = registry.entries.filter((entry) => entry.planned === undefined);
    const messageSources = new Map<string, string>();
    for (const entry of present)
      if (
        entry.activitySource !== undefined &&
        !messageSources.has(entry.activitySource) &&
        (changesPlan(entry) || coverageScopeRequiredFor(activitySourceEntry(entry.activitySource)))
      )
        messageSources.set(entry.activitySource, entry.name);
    const [health, imports] = await Promise.all([
      readHealth(sql, {
        now,
        entries: registry.entries,
        userId,
        processingFor: [...messageSources].map(([source, name]) => ({ source, name }))
      }),
      latestImports(sql, now, userId)
    ]);
    const processing = health.processing ?? [];
    const unused = graph.unused();
    const unusedIds = new Set(unused.entries.filter((item) => item.bucket === "unused").map((item) => item.id));
    const cadence = doctorSyncCadence();
    const sources: DoctorSourceInput[] = [];
    for (const entry of present) {
      const node = health.nodes[entry.id];
      if (!node) continue;
      const provider = syncProviderOf(entry);
      const run = imports.get(entry.activitySource ?? entry.id);
      sources.push({
        id: entry.id,
        name: entry.name,
        ...(entry.activitySource !== undefined ? { activitySource: entry.activitySource } : {}),
        keepsSyncChecks: entry.category === "calendar" || (provider !== undefined && provider in cadence),
        ...(entry.device !== undefined ? { device: entry.device } : {}),
        engineReads: graph.engineUse(entry.id).reads,
        ...(changesPlan(entry) ? { changesPlan: true as const } : {}),
        ...(entry.activitySource !== undefined && coverageScopeRequiredFor(activitySourceEntry(entry.activitySource))
          ? { messageSource: true as const }
          : {}),
        ...(node.coverage
          ? {
              coverage: {
                coveredTo: node.coverage.coveredTo,
                heartbeat: node.coverage.heartbeat,
                holes14d: node.coverage.holes14d,
                scopes: node.coverage.scopes.map((scope) => ({
                  scope: scope.scope,
                  coveredTo: scope.coveredTo,
                  ...(scope.retired ? { retired: true as const } : {})
                }))
              }
            }
          : {}),
        configured: node.configured,
        ...(node.credentialPresent ? { credentialPresent: true } : {}),
        freshness: node.freshness,
        lastSuccessAt: node.lastSuccessAt,
        threshold: node.threshold,
        ...(node.lateKinds ? { lateKinds: node.lateKinds } : {}),
        // A file export is a one-off archive, not a feed: rows from a fresh import are not "arriving".
        ...(node.count7d !== undefined && entry.method !== "file-import" ? { count7d: node.count7d } : {}),
        reachEmpty: entry.role === "source" && entry.passThrough !== true && graph.reach(entry.id).length === 0,
        ...(entry.health.kind === "json-stamp" && entry.health.path.includes("lastPhonePingAt")
          ? { phonePing: true }
          : {}),
        ...(entry.method === "file-import" ? { latestImport: run ?? null } : {})
      });
    }
    return {
      sources,
      devices: health.devices,
      // A token can only be bound by an extension's data-flow amend; with none registered the item has no fix to name.
      issues: health.issues.filter((issue) => issue.code !== "token_not_bound" || registry.extensionIds.length > 0),
      unused: unusedIds.size,
      nothingSends: unused.entries.filter((item) => item.bucket === "nothing-sends").length,
      ...(processing.length > 0 ? { processing } : {})
    };
  } catch (error) {
    // The driver's text can carry host and query detail, so it stays in the server log and the report is fixed.
    const code = (error as { code?: unknown } | null)?.code;
    log("error", "Doctor source health probes failed", {
      route: "/api/doctor",
      method: "GET",
      status: 200,
      durationMs: Date.now() - startedAt,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      ...(typeof code === "string" ? { errorCode: code } : {})
    });
    return {
      sources: [],
      devices: [],
      issues: [],
      unused: 0,
      nothingSends: 0,
      unavailable: true
    };
  }
}
