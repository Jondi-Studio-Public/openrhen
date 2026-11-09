import { doctorSyncCadence } from "@openrhen/contracts";
import {
  classifyFreshness,
  learnThreshold,
  thresholdFor,
  type DeviceHealth,
  type FlowEntry,
  type FreshnessState,
  type HealthIssue,
  type HealthProbe,
  type NodeHealth
} from "@openrhen/contracts/data-flow";
import { readExtensionSyncStatuses } from "@/server/persistence/postgres/sync-status-extensions";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

/**
 * Reads one live signal per registry entry (design 4.2): the newest good run, row, poll or use, and the newest
 * failure. It only SELECTs. It never creates the user, never records a run and never touches a plan table: a
 * connection that refuses writes can run it, and the integration test does exactly that. Probes are batched by kind,
 * only validated identifiers reach `sql(identifier)`, and results are cached in memory for 60 seconds.
 */

const CACHE_MS = 60_000;
const ERROR_MAX = 200;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SUCCESS = ["synced", "needs_review"];

/** What a probe saw, before thresholds are applied. */
interface Raw {
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastAttemptOk: boolean | null;
  lastError?: { at: Date; message: string } | null;
  everSeen: boolean;
  count24h?: number;
  count7d?: number;
  kinds?: string[];
  arrivals?: number[];
  note?: string | undefined;
  /** A lag probe found the downstream stage trailing: late even when its own clock is recent. */
  forceLate?: boolean;
}
type Outcome = Raw | { unresolved: string };

const clip = (text: string) => (text.length > ERROR_MAX ? text.slice(0, ERROR_MAX) : text);
const when = (value: Date | string | null | undefined) => (value ? new Date(value) : null);
const iso = (date: Date | null) => (date ? date.toISOString() : null);

export interface HealthResult {
  nodes: Record<string, NodeHealth>;
  issues: HealthIssue[];
  devices: DeviceHealth[];
}

export interface HealthOptions {
  now?: Date;
  /** The entries to probe: the live registry's by default. */
  entries: readonly FlowEntry[];
  /** Defaults to true; a test that seeds between reads passes false. */
  cache?: boolean;
}

let cached: { at: number; key: string; result: HealthResult } | null = null;

export function resetHealthCache(): void {
  cached = null;
}

interface Context {
  sql: Sql;
  userId: string | null;
  now: Date;
  userScoped: Map<string, boolean>;
}

async function userId(sql: Sql): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  return row?.id ?? null;
}

/** Whether a table has a `user_id` column; a probe on one filters by the owner. */
async function isUserScoped(context: Context, table: string): Promise<boolean> {
  const known = context.userScoped.get(table);
  if (known !== undefined) return known;
  const rows = await context.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = 'user_id'`;
  const scoped = (rows[0]?.n ?? 0) > 0;
  context.userScoped.set(table, scoped);
  return scoped;
}

async function tableHasColumns(context: Context, table: string, columns: readonly string[]): Promise<boolean> {
  const rows = await context.sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}`;
  const present = new Set(rows.map((row) => row.column_name));
  return columns.every((column) => present.has(column));
}

type SyncRun = { provider: string; status: string; started_at: Date; summary: Record<string, unknown> };

function fromRuns(runs: readonly SyncRun[]): Raw {
  const newest = runs[0];
  const success = runs.find((run) => SUCCESS.includes(run.status));
  const failed = runs.find((run) => run.status === "failed");
  const message = failed ? (failed.summary?.error ?? failed.summary?.message ?? failed.summary?.lastError) : undefined;
  return {
    lastSuccessAt: when(success?.started_at),
    lastAttemptAt: when(newest?.started_at),
    lastAttemptOk: newest ? SUCCESS.includes(newest.status) || newest.status === "not_configured" : null,
    lastError:
      failed && newest && !SUCCESS.includes(newest.status)
        ? { at: failed.started_at, message: clip(typeof message === "string" ? message : "the run failed") }
        : null,
    everSeen: runs.length > 0
  };
}

/** `sync-runs`: one query for every provider any entry names, including the `import:` and `ingest:` rows of activity. */
async function syncRunsFor(context: Context, providers: readonly string[]): Promise<Map<string, SyncRun[]>> {
  const out = new Map<string, SyncRun[]>();
  if (providers.length === 0 || !context.userId) return out;
  const rows = await context.sql<SyncRun[]>`
    SELECT provider, status, started_at, summary FROM integration_sync_runs
    WHERE user_id = ${context.userId} AND provider IN ${context.sql([...new Set(providers)])}
      AND started_at > ${new Date(context.now.getTime() - 90 * 86_400_000)}
    ORDER BY started_at DESC`;
  for (const row of rows) out.set(row.provider, [...(out.get(row.provider) ?? []), row]);
  return out;
}

const summaryMatches = (run: SyncRun, match: Record<string, string> | undefined) =>
  !match || Object.entries(match).every(([key, value]) => String(run.summary?.[key]) === value);

interface ActivityRead {
  last: Map<string, Date>;
  kinds: Map<string, { kind: string; c24: number; c7: number }[]>;
  arrivals: Map<string, number[]>;
  imported: Map<string, Date>;
}

async function readActivity(
  context: Context,
  sources: readonly string[],
  learnFor: ReadonlySet<string>
): Promise<ActivityRead> {
  const read: ActivityRead = { last: new Map(), kinds: new Map(), arrivals: new Map(), imported: new Map() };
  if (sources.length === 0 || !context.userId) return read;
  const list = context.sql([...sources]);
  const since30 = new Date(context.now.getTime() - 30 * 86_400_000);
  const since24 = new Date(context.now.getTime() - 86_400_000);
  const since7 = new Date(context.now.getTime() - 7 * 86_400_000);
  const [last, kinds, imports] = await Promise.all([
    context.sql<{ source: string; last: Date }[]>`
      SELECT source, max(ingested_at) AS last FROM activity_events
      WHERE user_id = ${context.userId} AND source IN ${list} GROUP BY source`,
    context.sql<{ source: string; kind: string; c24: number; c7: number }[]>`
      SELECT source, kind, count(*) FILTER (WHERE ingested_at > ${since24})::int AS c24,
        count(*) FILTER (WHERE ingested_at > ${since7})::int AS c7
      FROM activity_events
      WHERE user_id = ${context.userId} AND source IN ${list} AND ingested_at > ${since30}
      GROUP BY source, kind`,
    context.sql<{ source: string; last: Date }[]>`
      SELECT source, max(imported_at) AS last FROM activity_imports
      WHERE user_id = ${context.userId} AND source IN ${list} GROUP BY source`
  ]);
  for (const row of last) read.last.set(row.source, row.last);
  for (const row of kinds) read.kinds.set(row.source, [...(read.kinds.get(row.source) ?? []), row]);
  for (const row of imports) read.imported.set(row.source, row.last);
  const learn = sources.filter((source) => learnFor.has(source));
  if (learn.length > 0) {
    const buckets = await context.sql<{ source: string; hour: Date }[]>`
      SELECT source, date_trunc('hour', ingested_at) AS hour FROM activity_events
      WHERE user_id = ${context.userId} AND source IN ${context.sql(learn)} AND ingested_at > ${since30}
      GROUP BY 1, 2`;
    for (const row of buckets)
      read.arrivals.set(row.source, [...(read.arrivals.get(row.source) ?? []), row.hour.getTime()]);
  }
  return read;
}

function activityRaw(source: string, activity: ActivityRead, runs: Map<string, SyncRun[]>): Raw {
  const lastRow = activity.last.get(source) ?? null;
  const imported = activity.imported.get(source) ?? null;
  const kinds = activity.kinds.get(source) ?? [];
  const attempts = [...(runs.get(`ingest:${source}`) ?? []), ...(runs.get(`import:${source}`) ?? [])].sort(
    (a, b) => b.started_at.getTime() - a.started_at.getTime()
  );
  const newestRun = attempts[0];
  const rowAt = lastRow ?? imported;
  const success =
    [rowAt, ...attempts.filter((run) => SUCCESS.includes(run.status)).map((run) => run.started_at)]
      .filter((date): date is Date => date !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const failedLatest = newestRun && !SUCCESS.includes(newestRun.status) ? newestRun : undefined;
  const message = failedLatest?.summary?.error ?? failedLatest?.summary?.message;
  return {
    lastSuccessAt: success,
    lastAttemptAt: newestRun && (!success || newestRun.started_at > success) ? newestRun.started_at : success,
    lastAttemptOk: failedLatest && (!success || failedLatest.started_at > success) ? false : success ? true : null,
    lastError: failedLatest
      ? { at: failedLatest.started_at, message: clip(typeof message === "string" ? message : "a batch was rejected") }
      : null,
    everSeen: rowAt !== null || attempts.length > 0,
    count24h: kinds.reduce((total, kind) => total + kind.c24, 0),
    count7d: kinds.reduce((total, kind) => total + kind.c7, 0),
    kinds: kinds.map((kind) => kind.kind).sort(),
    arrivals: activity.arrivals.get(source) ?? []
  };
}

const simple = (date: Date | null, error: { at: Date; message: string } | null = null): Raw => ({
  lastSuccessAt: date,
  lastAttemptAt: date,
  lastAttemptOk: date !== null || error === null ? (date === null ? null : true) : false,
  lastError: error,
  everSeen: date !== null
});

type Resolve = (probe: HealthProbe, entry: FlowEntry) => Promise<Outcome>;

async function readMax(context: Context, probe: Extract<HealthProbe, { kind: "max" }>): Promise<Outcome> {
  const where = Object.entries(probe.where ?? {});
  const names = [probe.table, probe.column, ...where.map(([key]) => key)];
  if (!names.every((name) => IDENTIFIER.test(name)))
    return { unresolved: `an identifier in ${probe.table}.${probe.column} is not valid` };
  if (!(await tableHasColumns(context, probe.table, [probe.column, ...where.map(([key]) => key)])))
    return { unresolved: `${probe.table}.${probe.column} (or a filter column) does not exist` };
  const scoped = await isUserScoped(context, probe.table);
  if (scoped && !context.userId) return simple(null);
  const conditions = [
    ...(scoped ? [context.sql`user_id = ${context.userId!}`] : []),
    ...where.map(([key, value]) => context.sql`${context.sql(key)} = ${value}`)
  ];
  const clause =
    conditions.length === 0
      ? context.sql``
      : context.sql`WHERE ${conditions.reduce((a, b) => context.sql`${a} AND ${b}`)}`;
  const [row] = await context.sql<{ last: Date | null }[]>`
    SELECT max(${context.sql(probe.column)}) AS last FROM ${context.sql(probe.table)} ${clause}`;
  return simple(when(row?.last));
}

/** A Postgres array literal for a json path: `{"a","b"}`. */
const pathLiteral = (path: readonly string[]) =>
  `{${path.map((part) => `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;

async function readJsonStamp(context: Context, probe: Extract<HealthProbe, { kind: "json-stamp" }>): Promise<Outcome> {
  if (!IDENTIFIER.test(probe.column) || !(await tableHasColumns(context, probe.table, [probe.column])))
    return { unresolved: `${probe.table}.${probe.column} does not exist` };
  if (!context.userId) return simple(null);
  const [row] = await context.sql<{ stamp: string | null }[]>`
    SELECT ${context.sql(probe.column)} #>> ${pathLiteral(probe.path)}::text[] AS stamp
    FROM ${context.sql(probe.table)} WHERE user_id = ${context.userId}`;
  // Nothing written yet reads as never; a value that is not a time means the stamp's shape has changed.
  if (!row?.stamp) return { ...simple(null), everSeen: false };
  const stamp = new Date(row.stamp);
  if (Number.isNaN(stamp.getTime())) return { unresolved: `${probe.column} at ${probe.path.join(".")} is not a time` };
  return simple(stamp);
}

/** Runs every entry's probe, batching the set-based kinds, and gives each entry its raw outcome. */
async function probeAll(context: Context, entries: readonly FlowEntry[]): Promise<Map<string, Outcome>> {
  const probes = entries.map((entry) => ({ entry, probe: entry.health }));
  const providers = probes.flatMap(({ probe }) =>
    probe.kind === "sync-runs" ? [probe.provider] : probe.kind === "lag" ? lagProviders(probe) : []
  );
  const activitySources = entries.flatMap((entry) =>
    entry.health.kind === "activity"
      ? [entry.health.source]
      : entry.health.kind === "last-used" && entry.activitySource
        ? [entry.activitySource]
        : []
  );
  const learnFor = new Set(
    entries
      .filter((entry) => entry.method === "push" && entry.freshness === undefined && entry.activitySource !== undefined)
      .map((entry) => entry.activitySource!)
  );
  const runs = await syncRunsFor(context, [
    ...providers,
    ...activitySources.flatMap((s) => [`import:${s}`, `ingest:${s}`])
  ]);
  const activity = await readActivity(context, activitySources, learnFor);

  const extractors = probes.flatMap(({ probe }) => (probe.kind === "extractor" ? [probe.name] : []));
  const extractorRows =
    extractors.length > 0 && context.userId
      ? await context.sql<{ extractor: string; last_ok_at: Date | null; last_error: string | null }[]>`
          SELECT extractor, max(last_ok_at) AS last_ok_at, (array_agg(last_error ORDER BY active DESC))[1] AS last_error
          FROM extractor_state WHERE user_id = ${context.userId} AND extractor IN ${context.sql(extractors)}
          GROUP BY extractor`
      : [];
  const tokenNames = probes.flatMap(({ probe }) =>
    probe.kind === "last-used" && probe.tokenName ? [probe.tokenName] : []
  );
  const tokenRows =
    tokenNames.length > 0 && context.userId
      ? await context.sql<{ name: string; last_used_at: Date | null; live: number }[]>`
          SELECT name, max(last_used_at) AS last_used_at, count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > ${context.now})::int AS live
          FROM agent_tokens WHERE user_id = ${context.userId} AND name IN ${context.sql(tokenNames)} GROUP BY name`
      : [];
  const statuses = probes.some(({ probe }) => probe.kind === "sync-status")
    ? await readExtensionSyncStatuses(context.sql)
    : [];
  const since7 = new Date(context.now.getTime() - 7 * 86_400_000);
  const telemetryNames = probes.flatMap(({ probe }) => (probe.kind === "telemetry" ? [probe.name] : []));
  const telemetryRows =
    telemetryNames.length > 0
      ? await context.sql<{ provider: string; ok: boolean; started_at: Date; error_summary: string | null }[]>`
          SELECT provider, ok, started_at, error_summary FROM provider_call_telemetry
          WHERE kind = 'real_call' AND provider IN ${context.sql(telemetryNames)} AND started_at > ${since7} ORDER BY started_at DESC`
      : [];

  const resolve: Resolve = async (probe, entry) => {
    switch (probe.kind) {
      case "sync-runs":
        return fromRuns((runs.get(probe.provider) ?? []).filter((run) => summaryMatches(run, probe.summaryMatch)));
      case "sync-status": {
        const status = statuses.find((candidate) => candidate.provider === probe.provider);
        if (!status) return { unresolved: `no extension reports a sync status for ${probe.provider}` };
        const ok = when(status.lastSuccessAt);
        const bad = when(status.lastErrorAt);
        return {
          lastSuccessAt: ok,
          lastAttemptAt:
            [ok, bad].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
          lastAttemptOk: bad !== null && (ok === null || bad > ok) ? false : ok ? true : null,
          lastError: bad ? { at: bad, message: "the sync failed" } : null,
          everSeen: ok !== null || bad !== null
        };
      }
      case "activity":
        return activityRaw(probe.source, activity, runs);
      case "extractor": {
        const row = extractorRows.find((candidate) => candidate.extractor === probe.name);
        const ok = when(row?.last_ok_at);
        return {
          ...simple(ok, row?.last_error ? { at: ok ?? context.now, message: clip(row.last_error) } : null),
          everSeen: row !== undefined
        };
      }
      case "telemetry": {
        const mine = telemetryRows.filter((row) => row.provider === probe.name);
        const ok = mine.find((row) => row.ok);
        const newest = mine[0];
        const failed = mine.find((row) => !row.ok);
        return {
          lastSuccessAt: when(ok?.started_at),
          lastAttemptAt: when(newest?.started_at),
          lastAttemptOk: newest ? newest.ok : null,
          lastError:
            failed && newest && !newest.ok
              ? { at: failed.started_at, message: clip(failed.error_summary ?? "the call failed") }
              : null,
          everSeen: mine.length > 0
        };
      }
      case "max":
        return readMax(context, probe);
      case "last-used": {
        if (probe.tokenName === undefined) {
          return entry.activitySource
            ? activityRaw(entry.activitySource, activity, runs)
            : { unresolved: "no tokenName and no activity source" };
        }
        const row = tokenRows.find((candidate) => candidate.name === probe.tokenName);
        if (!row || row.live === 0) return { unresolved: `no live token is named ${probe.tokenName}` };
        return simple(when(row.last_used_at));
      }
      case "json-stamp":
        return readJsonStamp(context, probe);
      case "lag": {
        const [up, down] = await Promise.all([resolve(probe.upstream, entry), resolve(probe.downstream, entry)]);
        if ("unresolved" in up) return up;
        if ("unresolved" in down) return down;
        const behindHours =
          up.lastSuccessAt && down.lastSuccessAt
            ? (up.lastSuccessAt.getTime() - down.lastSuccessAt.getTime()) / 3_600_000
            : null;
        const trailing = behindHours !== null && behindHours > probe.allowHours;
        return {
          ...down,
          forceLate: trailing,
          note: trailing
            ? `trails its upstream by ${Math.round(behindHours!)} h (allowed ${probe.allowHours} h)`
            : undefined
        };
      }
      case "none":
        return { ...simple(null), everSeen: false, note: probe.reason };
    }
  };

  const out = new Map<string, Outcome>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        out.set(entry.id, await resolve(entry.health, entry));
      } catch (error) {
        out.set(entry.id, {
          unresolved: `the probe query failed: ${clip(error instanceof Error ? error.message : String(error))}`
        });
      }
    })
  );
  return out;
}

function lagProviders(probe: Extract<HealthProbe, { kind: "lag" }>): string[] {
  const own = (inner: HealthProbe) => (inner.kind === "sync-runs" ? [inner.provider] : []);
  return [...own(probe.upstream), ...own(probe.downstream)];
}

function nextStepFor(entry: FlowEntry, reason: string): string {
  const probe = entry.health;
  if (probe.kind === "last-used" && probe.tokenName)
    return `Check that an agent token named "${probe.tokenName}" exists and is not revoked, or correct tokenName for entry ${entry.id} in the extension's data-flow amend.`;
  if (probe.kind === "sync-status")
    return `Register an extension that reports a sync status for "${probe.provider}", or change entry ${entry.id}'s health probe in its data-flow entries file.`;
  if (probe.kind === "json-stamp")
    return `Check that "${probe.path.join(".")}" is still written into ${probe.table}.${probe.column}, or correct the path on entry ${entry.id}.`;
  return `Correct the health probe on entry ${entry.id} in platform/contracts/src/data-flow/entries (${reason}).`;
}

function deviceHealth(entries: readonly FlowEntry[], nodes: Record<string, NodeHealth>): DeviceHealth[] {
  const byDevice = new Map<string, FlowEntry[]>();
  for (const entry of entries) {
    if (entry.device === undefined) continue;
    byDevice.set(entry.device, [...(byDevice.get(entry.device) ?? []), entry]);
  }
  return [...byDevice.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, members]) => {
      let best: { at: string; from: string } | null = null;
      for (const member of members) {
        const at = nodes[member.id]?.lastSuccessAt;
        if (at && (!best || at > best.at)) best = { at, from: member.id };
      }
      return {
        id,
        ref: `ext:device/${id}`,
        entries: members.map((member) => member.id).sort(),
        lastSeenAt: best?.at ?? null,
        lastSeenFrom: best?.from ?? null
      };
    });
}

export async function readHealth(sql: Sql, options: HealthOptions): Promise<HealthResult> {
  const now = options.now ?? new Date();
  const key = options.entries.map((entry) => entry.id).join(",");
  if (
    options.cache !== false &&
    cached &&
    cached.key === key &&
    now.getTime() - cached.at < CACHE_MS &&
    now.getTime() >= cached.at
  )
    return cached.result;
  const context: Context = { sql, userId: await userId(sql), now, userScoped: new Map() };
  const entries = options.entries.filter((entry) => entry.planned === undefined);
  const outcomes = await probeAll(context, entries);
  const cadence = Object.fromEntries(
    Object.entries(doctorSyncCadence()).map(([provider, value]) => [provider, value.lateAfterMs])
  );

  const nodes: Record<string, NodeHealth> = {};
  const issues: HealthIssue[] = [];
  for (const entry of entries) {
    const outcome = outcomes.get(entry.id)!;
    const probe = entry.health;
    const base = { entryId: entry.id, probe: probe.kind };
    if ("unresolved" in outcome) {
      nodes[entry.id] = {
        ...base,
        configured: true,
        freshness: "probe_unresolved",
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        threshold: null,
        note: outcome.unresolved
      };
      issues.push({
        code: "probe_unresolved",
        entryId: entry.id,
        tier: "degrading",
        title: `The health probe for ${entry.name} cannot be read: ${outcome.unresolved}.`,
        next: nextStepFor(entry, outcome.unresolved)
      });
      continue;
    }
    if (probe.kind === "last-used" && probe.tokenName === undefined && entry.activitySource !== undefined) {
      issues.push({
        code: "token_not_bound",
        entryId: entry.id,
        tier: "tidy",
        title: `${entry.name} is judged by its rows because no token is bound to it.`,
        next: `Set tokenName for entry ${entry.id} in the extension's data-flow amend to the existing name of its agent token. Nothing on the device changes and no token is renamed.`
      });
    }
    const threshold = thresholdFor(entry, {
      cadenceLateAfterMs: cadence,
      learned: outcome.arrivals ? learnThreshold(outcome.arrivals) : null
    });
    const freshness: FreshnessState =
      probe.kind === "none"
        ? "n/a"
        : outcome.everSeen
          ? classifyFreshness({
              now: now.getTime(),
              lastSuccessAt: outcome.lastSuccessAt?.getTime() ?? null,
              lastAttemptAt: outcome.lastAttemptAt?.getTime() ?? null,
              lastAttemptOk: outcome.lastAttemptOk,
              threshold
            })
          : "never";
    nodes[entry.id] = {
      ...base,
      configured: outcome.everSeen,
      freshness:
        outcome.forceLate && freshness === "fresh"
          ? "late"
          : threshold === null && freshness !== "never" && freshness !== "failing"
            ? "n/a"
            : freshness,
      lastSuccessAt: iso(outcome.lastSuccessAt),
      lastAttemptAt: iso(outcome.lastAttemptAt),
      lastError: outcome.lastError
        ? { at: outcome.lastError.at.toISOString(), message: outcome.lastError.message }
        : null,
      ...(outcome.count24h !== undefined ? { count24h: outcome.count24h, count7d: outcome.count7d ?? 0 } : {}),
      ...(outcome.kinds ? { kindsSeen: outcome.kinds } : {}),
      threshold,
      ...(outcome.note ? { note: outcome.note } : {})
    };
  }
  const result: HealthResult = { nodes, issues, devices: deviceHealth(entries, nodes) };
  if (options.cache !== false) cached = { at: now.getTime(), key, result };
  return result;
}
