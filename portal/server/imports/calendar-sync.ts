import {
  connectionManifest,
  connectionRegistry,
  resolveTimezone,
  sourceLabel,
  type ConnectionManifest,
  type CalendarSyncProvider,
  type CalendarSyncResult,
  type GoogleCalendarFailureReason,
  type ImportRecord,
  type PreviewImport
} from "@openrhen/contracts";
import {
  fetchGoogleCalendarEvents,
  fetchGoogleCalendarProof
} from "@/integrations/google-calendar/google-calendar-proxy-client";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { isCalendarSyncEnabled } from "./calendar-sync-providers";
import { calendarSyncAdapterFor as registeredAdapterFor, requestCalendarPublish } from "./calendar-providers";
import { DEFAULT_MAX_DELETES } from "./publish-marker";
import { listSelectedGoogleCalendars } from "@/server/persistence/postgres/calendar-source-selections";
import { withImportStore, type PostgresImportStore } from "@/server/persistence/postgres/import-store";
import { sqlPool, type PoolSql } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl, runtimeEnv } from "@/server/runtime-env";

/**
 * Brings a read-only calendar's changes in automatically, one provider
 * at a time, reusing the import machinery so every change carries an audit trail and anything ambiguous
 * is held for a person. The worker's hourly trigger (`trigger: "scheduled"`) and a "Sync now" click
 * (`trigger: "manual"`) get the same `CalendarSyncResult` back and never a throw.
 *
 * What applies on its own: an update or delete to an event already linked to a commitment, when that
 * commitment is fed by no other source (the roster provider is the only primary source; when secondary sources disagree
 * the owner decides). What is held: new events, series and conflicts, and any change to a commitment another
 * source also feeds, all in one open review batch per provider that replaces the previous one.
 *
 * Everything provider-specific (what to read, how to diff it) sits behind `CalendarSyncAdapter`; a provider whose adapter lives in
 * the private seam registers it (`registerCalendarSyncAdapter`).
 */

const DEFAULT_SYNC_WINDOW_DAYS = 90;
/** How long a run's row is kept before the next sync prunes it. */
const RUN_RETENTION_DAYS = 90;

export interface PreparedCalendarDiff {
  records: ImportRecord[];
  previewFor: (records: ImportRecord[]) => PreviewImport;
}

export type CalendarRead =
  | { status: "not_configured"; missing: string[] }
  | { status: "failed"; message: string; reason?: GoogleCalendarFailureReason | undefined }
  /** Nothing to read yet (no calendar chosen): a normal, synced outcome with zero events. */
  | { status: "nothing_to_read" }
  | { status: "read"; eventCount: number; diff: (store: PostgresImportStore) => Promise<PreparedCalendarDiff> };

export interface CalendarSyncAdapter {
  provider: CalendarSyncProvider;
  /** The import batch source type this provider's batches carry. */
  sourceType: Parameters<PostgresImportStore["openBatches"]>[0];
  /** The `sources.source_type` of a commitment this provider wrote, to tell it from another source's. */
  ownSourceType: string;
  /** Reads the window. May throw an error carrying a `reason`; the sync turns that into a failed result. */
  read(args: {
    timeMin: string;
    timeMax: string;
    timezone: string;
    env: Record<string, string | undefined>;
  }): Promise<CalendarRead>;
  /**
   * Optional. Consulted only in `applyDiff`'s auto filter: a record this returns true for is held for
   * review even when it would otherwise apply on its own. A provider that omits it is unaffected.
   */
  holds?(record: ImportRecord): boolean;
}

/**
 * Whether an auto-eligible record spends the run's shared delete budget: a delete, or a date cancel
 * (a record whose `relationships.feedCancel` is "true"). Only a provider that emits `feedCancel` has
 * any of the latter, so for the others this is exactly "is a delete".
 */
function spendsDeleteBudget(record: ImportRecord): boolean {
  return record.operation === "delete" || record.relationships.feedCancel === "true";
}

/** Reads the chosen Google calendars over the window and hands the diff over to the import store. */
export const googleCalendarAdapter: CalendarSyncAdapter = {
  provider: "google_calendar",
  sourceType: "google_calendar",
  ownSourceType: "google_calendar_event",
  async read({ timeMin, timeMax, timezone, env }) {
    const url = databaseUrl();
    if (!url) return { status: "failed", message: "Calendar sync requires PostgreSQL." };
    const calendars = await listSelectedGoogleCalendars(sqlPool(url));
    // The connection is proved before the selection is consulted, so a missing sign-in never reads
    // as a clean sync just because no calendar is ticked yet.
    const proof = await fetchGoogleCalendarProof(env);
    if (proof.status === "not_configured") return { status: "not_configured", missing: proof.missing };
    if (proof.status === "failed") return { status: "failed", message: proof.message, reason: proof.reason };
    if (!calendars.length) return { status: "nothing_to_read" };
    const events = await fetchGoogleCalendarEvents(
      calendars.map((calendar) => calendar.calendarId),
      timeMin,
      timeMax,
      env
    );
    return {
      status: "read",
      eventCount: events.length,
      diff: (store) => store.diffGoogleCalendar({ timezone, timeMin, timeMax, events, calendars })
    };
  }
};

/** A local calendar date (`YYYY-MM-DD`) in `timezone`, the form a shared calendar's read takes. */
export function localDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Milliseconds the timezone's wall clock is ahead of UTC at this instant. */
function zoneOffsetMs(value: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(value);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  const wallAsUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wallAsUtc - Math.floor(value.getTime() / 1000) * 1000;
}

/**
 * The instant `days` calendar days after `value` at the same wall-clock time in the timezone. Adding
 * 24-hour multiples drifts an hour across a daylight-saving change, which moves the local end date.
 */
export function addCalendarDays(value: Date, days: number, timezone: string): Date {
  const naive = new Date(value.getTime() + days * 86_400_000);
  return new Date(naive.getTime() - (zoneOffsetMs(naive, timezone) - zoneOffsetMs(value, timezone)));
}

type DiffProfileId = NonNullable<ConnectionManifest["calendarSource"]>["diffProfile"];

/** Adapters by the diff profile a connection's manifest declares, never by connection id. */
const adapters: Partial<Record<DiffProfileId, CalendarSyncAdapter>> = {
  calendar: googleCalendarAdapter
};

function adapterFor(provider: CalendarSyncProvider): CalendarSyncAdapter | undefined {
  const profile = connectionManifest(provider)?.calendarSource?.diffProfile;
  return profile ? (adapters[profile] ?? registeredAdapterFor(profile)) : undefined;
}

/** Whether any connection can be published to (declares the `calendar_sink` capability). */
function hasCalendarSink(): boolean {
  return connectionRegistry().some((manifest) => manifest.capabilities.includes("calendar_sink"));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sqlOrNull(): PoolSql | null {
  const url = databaseUrl();
  return url ? sqlPool(url) : null;
}

/** The portal's timezone setting, falling back to `APP_TIMEZONE`, then a fixed default. */
export async function ownerTimezone(env: Record<string, string | undefined>): Promise<string> {
  const sql = sqlOrNull();
  let stored: string | undefined;
  if (sql) {
    const userId = await ensureUser(sql);
    const rows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
    stored = rows[0]?.timezone;
  }
  return resolveTimezone(stored, env);
}

/** Records one run, best-effort, and prunes rows older than 90 days for this provider. */
async function recordRun(run: {
  provider: CalendarSyncProvider;
  trigger: "manual" | "scheduled";
  startedAt: Date;
  finishedAt: Date;
  result: CalendarSyncResult;
}): Promise<void> {
  const sql = sqlOrNull();
  if (!sql) return;
  try {
    const userId = await ensureUser(sql);
    await sql`
      INSERT INTO integration_sync_runs (user_id, provider, trigger, started_at, finished_at, status, summary)
      VALUES (${userId}, ${run.provider}, ${run.trigger}, ${run.startedAt.toISOString()}, ${run.finishedAt.toISOString()}, ${run.result.status}, ${sql.json(run.result as never)})
    `;
    await sql`
      DELETE FROM integration_sync_runs
      WHERE user_id=${userId} AND provider=${run.provider} AND started_at < now() - (${RUN_RETENTION_DAYS} * INTERVAL '1 day')
    `;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Calendar sync run telemetry write failed",
        provider: run.provider,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

/** Whether a record would stop `commitReady` from committing it: the rule `import-store.ts` applies. */
function isBlocker(record: { removed: boolean; errors: unknown[]; operation: string }): boolean {
  return (
    !record.removed && (record.errors.length > 0 || record.operation === "conflict" || record.operation === "rejected")
  );
}

/** Stable text for comparing what a batch holds, as `googleCalendarSourceText` builds it. */
function sourceTextOf(preview: PreviewImport): string | undefined {
  return preview.source.text;
}

interface Applied {
  eventCount: number;
  updated: number;
  deleted: number;
  heldForReview: number;
  reviewBatchId: string | null;
  committedBatchId: string | null;
}

async function applyDiff(
  store: PostgresImportStore,
  adapter: CalendarSyncAdapter,
  eventCount: number,
  diff: PreparedCalendarDiff,
  maxDeletes: number = DEFAULT_MAX_DELETES
): Promise<Applied> {
  const base = { eventCount, updated: 0, deleted: 0, heldForReview: 0, reviewBatchId: null, committedBatchId: null };
  if (!diff.records.length) {
    // Nothing needs a decision any more, so a review batch left from an earlier run is stale.
    for (const open of await store.openBatches(adapter.sourceType)) await store.delete(open.id);
    return base;
  }

  const changed = diff.records.filter(
    (record) =>
      record.entityType === "fixed_commitment" &&
      (record.operation === "update" || record.operation === "delete") &&
      record.matchedEntityId
  );
  const fedElsewhere = await store.commitmentsFedByOtherSources(
    changed.map((record) => record.matchedEntityId!),
    adapter.provider,
    adapter.ownSourceType
  );
  // A delete applies on its own only when the calendar itself reports the event cancelled
  // (`remoteCancelled`): one that is merely missing from the read may have moved out of the window, or
  // the read may have come back short, so it waits for a person.
  let auto = changed.filter(
    (record) =>
      record.errors.length === 0 &&
      !fedElsewhere.has(record.matchedEntityId!) &&
      (record.operation === "update" || record.relationships.remoteCancelled === "true")
  );
  // An adapter may hold records back from applying on their own (optional; inert when absent).
  if (adapter.holds) auto = auto.filter((record) => !adapter.holds!(record));
  // The same guard as the publish sweep: past the threshold, every delete of the run is held. Date
  // cancels share the one budget with deletes (rule-end deletes included).
  if (auto.filter(spendsDeleteBudget).length > maxDeletes) auto = auto.filter((record) => !spendsDeleteBudget(record));
  let held = diff.records.filter((record) => !auto.includes(record));

  let committedBatchId: string | null = null;
  let updated = 0;
  let deleted = 0;
  if (auto.length) {
    const preview = await store.preview(diff.previewFor(auto));
    // Every auto record turned out to be a blocker once resolved against the database: `commitReady`
    // would throw rather than leave an empty committed batch, so hold them instead.
    if (!preview.records.some((record) => !isBlocker(record))) {
      await store.delete(preview.id);
      held = [...held, ...preview.records.filter((record) => !record.removed)];
    } else {
      const { batch, deferred } = await store.commitReady(preview.id, preview.version);
      committedBatchId = batch.id;
      const committed = batch.records.filter((record) => !record.removed);
      updated = committed.filter((record) => record.operation === "update").length;
      deleted = committed.filter((record) => record.operation === "delete").length;
      if (deferred) {
        // Rows that became blockers between the diff and the commit: hold them with the rest.
        held = [...held, ...deferred.records.filter((record) => !record.removed)];
        await store.delete(deferred.id);
      }
    }
  }

  if (!held.length) {
    for (const open of await store.openBatches(adapter.sourceType)) await store.delete(open.id);
    return { ...base, updated, deleted, committedBatchId };
  }

  const heldPreview = diff.previewFor(held);
  const open = await store.openBatches(adapter.sourceType);
  // The same events waiting for the same decisions as the review batch already open: leave that batch,
  // and whatever has been ticked in it, alone rather than replacing it every hour.
  const unchanged = open.find((batch) => batch.sourceText !== null && batch.sourceText === sourceTextOf(heldPreview));
  if (unchanged) {
    for (const other of open) if (other.id !== unchanged.id) await store.delete(other.id);
    return { ...base, updated, deleted, heldForReview: held.length, reviewBatchId: unchanged.id, committedBatchId };
  }
  // A person may already have deselected some of these in the batch about to be replaced; keep that.
  const wasRemoved = new Set<string>();
  for (const batch of open) {
    const previous = await store.get(batch.id);
    for (const record of previous?.records ?? []) if (record.removed) wasRemoved.add(record.importKey);
  }
  const carried = {
    ...heldPreview,
    records: heldPreview.records.map((record) =>
      wasRemoved.has(record.importKey) ? { ...record, removed: true } : record
    )
  };
  const review = await store.preview(carried);
  await store.supersedeOpenBatches(adapter.sourceType, review.id);
  return { ...base, updated, deleted, heldForReview: held.length, reviewBatchId: review.id, committedBatchId };
}

/** Runs `run` under the provider's advisory lock, or reports that another sync holds it (never waits). */
async function withProviderLock<T>(
  provider: CalendarSyncProvider,
  run: () => Promise<T>
): Promise<{ locked: true; value: T } | { locked: false }> {
  const sql = sqlOrNull();
  // No database: nothing to lock, and the run itself will report the missing database.
  if (!sql) return { locked: true, value: await run() };
  const userId = await ensureUser(sql);
  // Session-level lock on one reserved connection, as the publish sweep does: the run makes its
  // own transactions and outbound calls, so a transaction-scoped lock would pin a pooled connection.
  const reserved = await sql.reserve();
  let locked = false;
  try {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${`calendar_sync:${provider}:${userId}`}, 0)) AS locked
    `;
    locked = rows[0]?.locked === true;
    if (!locked) return { locked: false };
    return { locked: true, value: await run() };
  } finally {
    if (locked)
      await reserved`SELECT pg_advisory_unlock(hashtextextended(${`calendar_sync:${provider}:${userId}`}, 0))`.catch(
        () => undefined
      );
    reserved.release();
  }
}

/**
 * One sync of one provider. Refuses a provider not in `CALENDAR_SYNC_PROVIDERS`, and takes a per
 * (user, provider) advisory lock so a "Sync now" and the hourly run never overlap: the one that loses
 * reports `already_running`, changes nothing and records no run. Never throws.
 */
export async function runCalendarSync(args: {
  provider: CalendarSyncProvider;
  trigger: "manual" | "scheduled";
  adapter?: CalendarSyncAdapter | undefined;
}): Promise<CalendarSyncResult> {
  const { provider } = args;
  if (!isCalendarSyncEnabled(provider, runtimeEnv()))
    return {
      status: "not_enabled",
      provider,
      message: `Calendar sync is off for ${sourceLabel(provider)}: it is not in CALENDAR_SYNC_PROVIDERS.`
    };
  try {
    const outcome = await withProviderLock(provider, () => runCalendarSyncLocked(args));
    return outcome.locked
      ? outcome.value
      : { status: "already_running", provider, message: "A sync is already running for this calendar." };
  } catch (error) {
    return {
      status: "failed",
      provider,
      syncedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "The calendar sync failed."
    };
  }
}

async function runCalendarSyncLocked({
  provider,
  trigger,
  adapter = adapterFor(provider)
}: {
  provider: CalendarSyncProvider;
  trigger: "manual" | "scheduled";
  adapter?: CalendarSyncAdapter | undefined;
}): Promise<CalendarSyncResult> {
  const startedAt = new Date();
  const finish = async (result: CalendarSyncResult) => {
    await recordRun({ provider, trigger, startedAt, finishedAt: new Date(), result });
    // A sync commit does not notify state_changed, so a moved commitment that is shared with the
    // family calendar is republished from here, as the roster sync does. Any source's commit can move one,
    // so this asks whenever a connection can be published to.
    if ("committedBatchId" in result && result.committedBatchId && hasCalendarSink()) requestCalendarPublish();
    return result;
  };
  const failed = (message: string, reason?: GoogleCalendarFailureReason): CalendarSyncResult => ({
    status: "failed",
    provider,
    syncedAt: new Date().toISOString(),
    message,
    ...(reason ? { reason } : {})
  });
  if (!adapter) return finish(failed(`Calendar sync is not available for ${provider}.`));

  try {
    const env = runtimeEnv();
    const timezone = await ownerTimezone(env);
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = addCalendarDays(
      now,
      positiveInteger(env.CALENDAR_SYNC_WINDOW_DAYS, DEFAULT_SYNC_WINDOW_DAYS),
      timezone
    ).toISOString();
    const synced = (applied: Applied): CalendarSyncResult => ({
      status: applied.heldForReview > 0 ? "needs_review" : "synced",
      provider,
      syncedAt: new Date().toISOString(),
      timeMin,
      timeMax,
      ...applied
    });

    const read = await adapter.read({ timeMin, timeMax, timezone, env });
    if (read.status === "not_configured") return finish({ status: "not_configured", missing: read.missing });
    if (read.status === "failed") return finish(failed(read.message, read.reason));
    if (read.status === "nothing_to_read")
      return finish(
        synced({ eventCount: 0, updated: 0, deleted: 0, heldForReview: 0, reviewBatchId: null, committedBatchId: null })
      );

    const applied = await withImportStore(async (store) =>
      applyDiff(
        store,
        adapter,
        read.eventCount,
        await read.diff(store),
        positiveInteger(env.CALENDAR_SYNC_MAX_DELETES, DEFAULT_MAX_DELETES)
      )
    );
    return finish(synced(applied));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The calendar sync failed.";
    const reason = (error as { reason?: GoogleCalendarFailureReason } | null)?.reason;
    return finish(failed(message, reason));
  }
}
