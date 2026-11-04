import { redact } from "@/server/logging";
import { databaseUrl } from "@/server/runtime-env";
import { sqlPool, type PoolSql } from "@/server/persistence/postgres/sql-pool";
import { connectionRegistry } from "@openrhen/contracts";
import { pruneExpiredProviderTelemetry } from "@openrhen/database";

/**
 * Timing and reachability telemetry for every external provider call, recorded at the layer where
 * calls to the outbound-proxy sidecar actually happen — the portal-side proxy clients — rather than
 * sprinkled at each call site. The sidecar itself holds every third-party credential but no database
 * connection (deliberately: it is the one process published to nothing, and stays that simple), so
 * this lives on the portal side, which already has one.
 *
 * A future provider needs only a new entry in `KNOWN_PROVIDERS` and a call wrapped in
 * `recordProviderCall` or `recordStreamingProviderCall`; nothing else in this module changes.
 */
export const KNOWN_PROVIDERS: readonly string[] = connectionRegistry().flatMap((manifest) =>
  manifest.telemetryName ? [manifest.telemetryName] : []
);
export type ProviderName = string;

type CallKind = "real_call" | "probe";

export interface CallOutcome {
  ok: boolean;
  /** Populated when `ok` is false and the wrapped call returned a domain failure rather than throwing. */
  detail?: string | null;
  /**
   * The provider is not set up (no sidecar, or missing settings on it). That is a state, not a
   * failure, so the outcome is never recorded as a failed call and the status reads "not set up".
   */
  notConfigured?: boolean;
  /**
   * Token usage lifted straight off the provider's own response when it was already there for the
   * taking (every OpenAI Responses API reply carries a `usage` block) — never a second call to find
   * out. Absent for every non-LLM provider and for any LLM call where the response did not carry it.
   */
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** 7 days: enough to eyeball a slow week, small enough that nobody needs to think about this table. */
const RETENTION_DAYS = 7;
/** The window the Connections page averages over and the window a probe's rate limit is measured against. */
export const AVERAGE_WINDOW_HOURS = 24;
/**
 * Any successful real call inside this window counts as proof of reachability — no probe on top of
 * it — and a probe itself is not repeated inside this window. 5 minutes matches "at most one probe
 * per ~5 minutes per provider" from the design: one constant, two jobs.
 */
export const REACHABILITY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Typed `PoolSql`, not the broader `Sql` union that also covers an open transaction handle: this
 * always comes straight from `sqlPool`, never from inside someone else's transaction, and `PoolSql`
 * is what `pruneExpiredProviderTelemetry` (a plain `postgres.Sql`) needs to accept it without a cast.
 */
function sqlOrNull(): PoolSql | null {
  const url = databaseUrl();
  return url ? sqlPool(url) : null;
}

function elapsedMs(startedAtMonotonic: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtMonotonic));
}

function summarize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redact(message);
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

interface TelemetryRow {
  provider: ProviderName;
  operation: string;
  kind: CallKind;
  startedAt: Date;
  firstByteMs: number | null;
  totalMs: number | null;
  ok: boolean;
  errorSummary: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Writes one telemetry row, best-effort. A failure here must never take down the provider call it is
 * measuring, so it is logged and swallowed rather than thrown — the same posture `withRoute` takes
 * toward its own request line.
 */
async function insertRow(row: TelemetryRow): Promise<void> {
  const sql = sqlOrNull();
  if (!sql) return;
  try {
    await sql`
      INSERT INTO provider_call_telemetry
        (provider, operation, kind, started_at, first_byte_ms, total_ms, ok, error_summary, input_tokens, output_tokens)
      VALUES
        (${row.provider}, ${row.operation}, ${row.kind}, ${row.startedAt.toISOString()},
         ${row.firstByteMs}, ${row.totalMs}, ${row.ok}, ${row.errorSummary}, ${row.inputTokens}, ${row.outputTokens})
    `;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Provider call telemetry write failed",
        provider: row.provider,
        operation: row.operation,
        errorMessage: summarize(error)
      })
    );
  }
}

async function recordProviderEvent<T>(
  provider: ProviderName,
  operation: string,
  kind: CallKind,
  run: () => Promise<T>,
  classify: (result: T) => CallOutcome
): Promise<T> {
  const startedAt = new Date();
  const start = performance.now();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await insertRow({
      provider,
      operation,
      kind,
      startedAt,
      firstByteMs: null,
      totalMs: elapsedMs(start),
      ok: false,
      errorSummary: summarize(error),
      inputTokens: null,
      outputTokens: null
    });
    throw error;
  }
  const outcome = classify(result);
  if (outcome.notConfigured) return result;
  await insertRow({
    provider,
    operation,
    kind,
    startedAt,
    firstByteMs: null,
    totalMs: elapsedMs(start),
    ok: outcome.ok,
    errorSummary: outcome.ok ? null : (outcome.detail ?? null),
    inputTokens: outcome.inputTokens ?? null,
    outputTokens: outcome.outputTokens ?? null
  });
  return result;
}

/**
 * Times a non-streaming provider call and records total time-to-result. `classify` decides success
 * for a call whose failure comes back as a normal result rather than a throw (the calendar provider proof
 * check, for one); the default treats "did not throw" as success, which is right for every call that
 * throws on failure — every OpenAI extraction and every travel lookup in this codebase does.
 */
export function recordProviderCall<T>(
  provider: ProviderName,
  operation: string,
  run: () => Promise<T>,
  classify: (result: T) => CallOutcome = () => ({ ok: true })
): Promise<T> {
  return recordProviderEvent(provider, operation, "real_call", run, classify);
}

/**
 * Times a streaming provider call. `run` receives `markFirstByte`, which the caller invokes the
 * moment the first streamed token/word arrives; only the first call counts, so it is safe to call on
 * every delta. Records both `first_byte_ms` (the headline metric for a streaming call) and the total
 * time to the complete reply.
 */
export async function recordStreamingProviderCall<T>(
  provider: ProviderName,
  operation: string,
  run: (markFirstByte: () => void) => Promise<T>,
  classify: (result: T) => CallOutcome = () => ({ ok: true })
): Promise<T> {
  const startedAt = new Date();
  const start = performance.now();
  let firstByteMs: number | null = null;
  const markFirstByte = () => {
    if (firstByteMs === null) firstByteMs = elapsedMs(start);
  };
  let result: T;
  try {
    result = await run(markFirstByte);
  } catch (error) {
    await insertRow({
      provider,
      operation,
      kind: "real_call",
      startedAt,
      firstByteMs,
      totalMs: elapsedMs(start),
      ok: false,
      errorSummary: summarize(error),
      inputTokens: null,
      outputTokens: null
    });
    throw error;
  }
  const outcome = classify(result);
  await insertRow({
    provider,
    operation,
    kind: "real_call",
    startedAt,
    firstByteMs,
    totalMs: elapsedMs(start),
    ok: outcome.ok,
    errorSummary: outcome.ok ? null : (outcome.detail ?? null),
    inputTokens: outcome.inputTokens ?? null,
    outputTokens: outcome.outputTokens ?? null
  });
  return result;
}

/** Runs and records a reachability probe. `run` never throws by convention — see `provider-probes.ts`. */
export function recordProviderProbe(provider: ProviderName, operation: string, run: () => Promise<CallOutcome>) {
  return recordProviderEvent(provider, operation, "probe", run, (outcome) => outcome);
}

/**
 * How a provider answers "are you reachable right now" when nothing recent settles the question.
 *
 * `probe` is the ordinary case: a synthetic lightweight request (OpenAI's model listing, the calendar provider's
 * proof check) that exists purely to answer the question. `getProviderStatus` times and records it
 * itself, tagged `kind: 'probe'`.
 *
 * `self_recording` is for a check that is — or attempts to be — a real call the app benefits from
 * regardless of the reachability question (Google's travel-matrix refresh, run only when a located
 * upcoming commitment's estimate has actually gone stale). Its `run` already recorded its own
 * `kind: 'real_call'` row via `recordProviderCall` further down the call chain, so `getProviderStatus`
 * must not record a second one — it only reads the outcome back. `status: 'skipped'` means no request
 * was made at all because there was nothing worth refreshing; nothing is recorded for that either.
 */
export type ReachabilityCheck =
  | { kind: "probe"; run: () => Promise<CallOutcome> }
  | {
      kind: "self_recording";
      run: () => Promise<
        { status: "checked"; ok: boolean; detail?: string | null } | { status: "skipped"; detail: string }
      >;
    };

/**
 * Deletes telemetry rows older than the retention window, using the same query the Plan and Forecast
 * Worker now runs hourly (see `pruneExpiredProviderTelemetry` in `plan-retention.ts`) so pruning has
 * one implementation. Best-effort: a failure here changes nothing else. Still called once per request
 * by `POST /api/connections/status`, so a page opened between hourly sweeps is not left showing rows
 * the worker would otherwise have already dropped.
 */
export async function pruneOldProviderTelemetry(): Promise<void> {
  const sql = sqlOrNull();
  if (!sql) return;
  try {
    await pruneExpiredProviderTelemetry(sql, RETENTION_DAYS);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Provider call telemetry prune failed",
        errorMessage: summarize(error)
      })
    );
  }
}

export interface ProviderStatus {
  provider: ProviderName;
  /** `null` only when there is no database configured at all. */
  reachable: boolean | null;
  /**
   * What the reachability verdict is based on: a genuine call, a synthetic probe, nothing yet
   * observed, or — Google only — an active check that found nothing worth refreshing and so made no
   * request at all. `not_configured` means the provider is not set up yet: no failure, nothing recorded.
   */
  source: "real_call" | "probe" | "none" | "skipped" | "not_configured";
  checkedAt: string | null;
  detail: string | null;
  /** True when a fresh probe was skipped because one already ran inside the rate-limit window. */
  rateLimited: boolean;
  avgFirstByteMs: number | null;
  firstByteSampleCount: number;
  avgTotalMs: number | null;
  totalSampleCount: number;
  lastCallAt: string | null;
  lastCallOk: boolean | null;
  lastCallOperation: string | null;
  /** Real-call volume by operation over the last 24h, e.g. `geocode` vs `travel_matrix` for Google. */
  callCountsByOperation: { operation: string; count: number }[];
  /** LLM token usage summed over the last 24h, when the provider's responses carried it; null otherwise. */
  inputTokens24h: number | null;
  outputTokens24h: number | null;
}

interface StoredRow {
  kind: CallKind;
  operation: string;
  started_at: Date;
  first_byte_ms: number | null;
  total_ms: number | null;
  ok: boolean;
  error_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Passive-first reachability, with a lazy active probe as the fallback.
 *
 * A successful real call inside the rate-limit window is reachability proof on its own — no probe is
 * made on top of it. Absent that, a probe already made inside the window is reused rather than
 * repeated. Only when neither exists is `probe` actually called, so a provider with steady real
 * traffic is never probed at all, and an idle one is probed at most once per window regardless of how
 * many times this is called meanwhile (a page load, a "check now" click, both land here).
 */
export async function getProviderStatus(provider: ProviderName, check: ReachabilityCheck): Promise<ProviderStatus> {
  const sql = sqlOrNull();
  const empty: ProviderStatus = {
    provider,
    reachable: null,
    source: "none",
    checkedAt: null,
    detail: "The database is not configured, so telemetry cannot be read.",
    rateLimited: false,
    avgFirstByteMs: null,
    firstByteSampleCount: 0,
    avgTotalMs: null,
    totalSampleCount: 0,
    lastCallAt: null,
    lastCallOk: null,
    lastCallOperation: null,
    callCountsByOperation: [],
    inputTokens24h: null,
    outputTokens24h: null
  };
  if (!sql) return empty;
  // Bounded to the window every metric below actually needs (reachability looks back 5 minutes,
  // averages and call counts look back 24h): with the `(provider, started_at)` index this reads a
  // handful of rows instead of the up-to-1000 most recent rows regardless of age that an unbounded
  // `ORDER BY started_at DESC LIMIT 1000` would have to scan on a busy provider.
  const rows = await sql<StoredRow[]>`
    SELECT kind, operation, started_at, first_byte_ms, total_ms, ok, error_summary, input_tokens, output_tokens
    FROM provider_call_telemetry
    WHERE provider = ${provider} AND started_at > now() - (${AVERAGE_WINDOW_HOURS} * INTERVAL '1 hour')
    ORDER BY started_at DESC
    LIMIT 1000
  `;
  // The most recent real call regardless of age (up to the 7-day retention window), read separately
  // and cheaply — a single indexed row — rather than by widening the bounded read above.
  const lastCallRows = await sql<Pick<StoredRow, "operation" | "started_at" | "ok">[]>`
    SELECT operation, started_at, ok
    FROM provider_call_telemetry
    WHERE provider = ${provider} AND kind = 'real_call'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const now = Date.now();
  const recentSuccessfulRealCall = rows.find(
    (row) => row.kind === "real_call" && row.ok && now - row.started_at.getTime() < REACHABILITY_WINDOW_MS
  );
  const recentProbe = rows.find(
    (row) => row.kind === "probe" && now - row.started_at.getTime() < REACHABILITY_WINDOW_MS
  );

  let reachable: boolean | null;
  let source: "real_call" | "probe" | "skipped" | "not_configured";
  let checkedAt: string | null;
  let detail: string | null;
  let rateLimited: boolean;

  if (recentSuccessfulRealCall) {
    reachable = true;
    source = "real_call";
    checkedAt = recentSuccessfulRealCall.started_at.toISOString();
    detail = null;
    rateLimited = false;
  } else if (recentProbe) {
    reachable = recentProbe.ok;
    source = "probe";
    checkedAt = recentProbe.started_at.toISOString();
    detail = recentProbe.ok ? null : recentProbe.error_summary;
    rateLimited = true;
  } else if (check.kind === "probe") {
    const outcome = await recordProviderProbe(provider, "reachability_probe", check.run);
    reachable = outcome.notConfigured ? null : outcome.ok;
    source = outcome.notConfigured ? "not_configured" : "probe";
    checkedAt = outcome.notConfigured ? null : new Date().toISOString();
    detail = outcome.ok ? null : (outcome.detail ?? "The probe failed.");
    rateLimited = false;
  } else {
    // `run` here already made (or chose not to make) the request and recorded its own telemetry row
    // when it did, so nothing more is recorded on this path — only the outcome is read back.
    const result = await check.run();
    if (result.status === "skipped") {
      reachable = null;
      source = "skipped";
      checkedAt = null;
      detail = result.detail;
      rateLimited = false;
    } else {
      reachable = result.ok;
      source = "real_call";
      checkedAt = new Date().toISOString();
      detail = result.ok ? null : (result.detail ?? "The check failed.");
      rateLimited = false;
    }
  }

  // Probe rows are deliberately excluded from every metric below: a probe exercises a different,
  // usually much cheaper operation (OpenAI's model listing, not a real completion), so folding its
  // timing into "average response time" would understate real latency and its volume would inflate
  // call counts for traffic that never happened.
  const cutoff = now - AVERAGE_WINDOW_HOURS * 60 * 60 * 1000;
  const realCallsWithin24h = rows.filter((row) => row.kind === "real_call" && row.started_at.getTime() >= cutoff);
  const firstByteSamples = realCallsWithin24h
    .map((row) => row.first_byte_ms)
    .filter((value): value is number => value !== null);
  const totalSamples = realCallsWithin24h.map((row) => row.total_ms).filter((value): value is number => value !== null);
  const lastCall = lastCallRows[0] ?? null;

  const countByOperation = new Map<string, number>();
  for (const row of realCallsWithin24h)
    countByOperation.set(row.operation, (countByOperation.get(row.operation) ?? 0) + 1);
  const callCountsByOperation = [...countByOperation.entries()]
    .map(([operation, count]) => ({ operation, count }))
    .sort((left, right) => right.count - left.count || left.operation.localeCompare(right.operation));

  const inputTokenRows = realCallsWithin24h.filter((row) => row.input_tokens !== null);
  const outputTokenRows = realCallsWithin24h.filter((row) => row.output_tokens !== null);

  return {
    provider,
    reachable,
    source,
    checkedAt,
    detail,
    rateLimited,
    avgFirstByteMs: average(firstByteSamples),
    firstByteSampleCount: firstByteSamples.length,
    avgTotalMs: average(totalSamples),
    totalSampleCount: totalSamples.length,
    lastCallAt: lastCall ? lastCall.started_at.toISOString() : null,
    lastCallOk: lastCall ? lastCall.ok : null,
    lastCallOperation: lastCall ? lastCall.operation : null,
    callCountsByOperation,
    inputTokens24h: inputTokenRows.length
      ? inputTokenRows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0)
      : null,
    outputTokens24h: outputTokenRows.length
      ? outputTokenRows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0)
      : null
  };
}
