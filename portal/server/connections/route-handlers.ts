import { z } from "zod";
import { CAPABILITY_OPS, connectionManifest, type CapabilityId, type ConnectionManifest } from "@openrhen/contracts";
import { proveCalendarSource } from "@/integrations/calendar-source-client";
import { fetchGoogleCalendars } from "@/integrations/google-calendar/google-calendar-proxy-client";
import { ensureCalendarPublishSubscribed } from "@/server/events/state-events";
import { runCalendarSync } from "@/server/imports/calendar-sync";
import { isCalendarSyncEnabled } from "@/server/imports/calendar-sync-providers";
import { providerConnectionHandlers, type ProviderConnectionHandlers } from "@/server/imports/calendar-providers";
import { diffProfileTraits } from "@/server/persistence/postgres/imports/calendar-diff";
import { redact, type RequestLog } from "@/server/logging";
import {
  listGoogleCalendarSelections,
  saveGoogleCalendarSelections
} from "@/server/persistence/postgres/calendar-source-selections";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl, runtimeEnv } from "@/server/runtime-env";

/**
 * The portal's connection routes, dispatched by capability and diff profile, never by connection id:
 * `/api/connections/[connectionId]/{sync,proof,calendars}`. The handlers are plain functions; each route file
 * wraps them in `withRoute` with its own template.
 */
export type ConnectionRouteHandler = (
  connectionId: string,
  request: Request,
  context: unknown,
  log: RequestLog
) => Promise<Response>;

function declares(manifest: ConnectionManifest, capability: CapabilityId, op: string): boolean {
  if (!manifest.capabilities.includes(capability)) return false;
  const ops: readonly string[] = manifest.ops?.[capability] ?? CAPABILITY_OPS[capability];
  return ops.includes(op);
}

/**
 * Calendar choices are stored once, not per connection, and only Google lists calendars today. Until the
 * selections are per connection, no other id may read or overwrite them, whatever its manifest declares.
 */
function calendarsFor(id: string) {
  const found = calendarSourceFor(id, "list_calendars");
  if (found instanceof Response) return found;
  if (found.manifest.id !== "google_calendar")
    return Response.json(
      { error: `${found.manifest.label} does not support that.`, reason: "unsupported_operation" },
      { status: 404 }
    );
  return found;
}

function unsupported(manifest: ConnectionManifest): Response {
  return Response.json(
    { error: `${manifest.label} does not support that.`, reason: "unsupported_operation" },
    { status: 404 }
  );
}

/**
 * A roster profile has no generic body: its sync and proof are the connection's own, registered by the provider.
 * Without a registered body the connection is unsupported, whatever its manifest says.
 */
function isRosterWithoutHandler(manifest: ConnectionManifest, op: "sync" | "proof"): boolean {
  const profile = manifest.calendarSource?.diffProfile;
  return (
    profile !== undefined &&
    diffProfileTraits(profile).ownSync === true &&
    !providerConnectionHandlers(manifest.id)?.[op]
  );
}

/**
 * The calendar-sink manifest for `id` that declares `op`, or the 404 to answer instead. Publishing, removal and the
 * write proof are the sink's own registered functions, so a sink without them is unsupported, whatever its
 * manifest declares.
 */
function calendarSinkFor(
  id: string,
  op: string
): { manifest: ConnectionManifest; publish: NonNullable<ProviderConnectionHandlers["publish"]> } | Response {
  const manifest = connectionManifest(id);
  if (!manifest)
    return Response.json({ error: "That connection is not known.", reason: "unknown_connection" }, { status: 404 });
  const publish = providerConnectionHandlers(manifest.id)?.publish;
  if (!declares(manifest, "calendar_sink", op) || !publish)
    return Response.json(
      { error: `${manifest.label} does not support that.`, reason: "unsupported_operation" },
      { status: 404 }
    );
  return { manifest, publish };
}

/** The calendar-source manifest for `id` that declares `op`, or the 404 to answer instead. */
function calendarSourceFor(
  id: string,
  op: string
): { manifest: ConnectionManifest & { calendarSource: NonNullable<ConnectionManifest["calendarSource"]> } } | Response {
  const manifest = connectionManifest(id);
  if (!manifest)
    return Response.json({ error: "That connection is not known.", reason: "unknown_connection" }, { status: 404 });
  if (!declares(manifest, "calendar_source", op) || !manifest.calendarSource)
    return Response.json(
      { error: `${manifest.label} does not support that.`, reason: "unsupported_operation" },
      { status: 404 }
    );
  return {
    manifest: manifest as ConnectionManifest & { calendarSource: NonNullable<ConnectionManifest["calendarSource"]> }
  };
}

/** Runs a sync: the worker's scheduled trigger and a "Sync now" click post here. */
export const syncPostHandler: ConnectionRouteHandler = async (connectionId, request, _context, log) => {
  const found = calendarSourceFor(connectionId, "read_events");
  if (found instanceof Response) return found;
  const { manifest } = found;
  if (isRosterWithoutHandler(manifest, "sync")) return unsupported(manifest);
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";
  try {
    const result = diffProfileTraits(manifest.calendarSource.diffProfile).ownSync
      ? await providerConnectionHandlers(manifest.id)!.sync!({ trigger })
      : await runCalendarSync({ provider: manifest.id, trigger });
    return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : `The ${manifest.label} sync failed.` },
      { status: 400 }
    );
  }
};

type RunRow = { started_at: Date; finished_at: Date | null; trigger: string; status: string; summary: unknown };

function runView(row: RunRow | undefined) {
  return row
    ? {
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
        trigger: row.trigger,
        status: row.status,
        summary: row.summary
      }
    : null;
}

/** The most recent run's outcome, for Connections to show and the worker to seed its schedule from. */
export const syncGetHandler: ConnectionRouteHandler = async (connectionId) => {
  const found = calendarSourceFor(connectionId, "read_events");
  if (found instanceof Response) return found;
  const { manifest } = found;
  if (isRosterWithoutHandler(manifest, "sync")) return unsupported(manifest);
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json({ error: `${manifest.label} sync history requires PostgreSQL.` }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const provider = manifest.id;
  const rows = await sql<RunRow[]>`
    SELECT started_at, finished_at, trigger, status, summary
    FROM integration_sync_runs
    WHERE user_id=${userId} AND provider=${provider}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!diffProfileTraits(manifest.calendarSource.diffProfile).reportsLastGoodRun)
    return Response.json({ enabled: isCalendarSyncEnabled(provider, runtimeEnv()), lastRun: runView(row) });
  // A roster is only as fresh as its last good run, which a failed run since then does not change.
  const good = await sql<{ finished_at: Date | null; started_at: Date }[]>`
    SELECT started_at, finished_at
    FROM integration_sync_runs
    WHERE user_id=${userId} AND provider=${provider} AND status IN ('synced', 'needs_review')
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const lastGood = good[0];
  // Runs older than the retention window are pruned, so a long run of failures can leave no success row at all.
  // The oldest run still held tells the portal whether that has happened.
  const oldest = await sql<{ started_at: Date }[]>`
    SELECT started_at
    FROM integration_sync_runs
    WHERE user_id=${userId} AND provider=${provider}
    ORDER BY started_at ASC
    LIMIT 1
  `;
  return Response.json({
    oldestRunAt: oldest[0] ? oldest[0].started_at.toISOString() : null,
    lastSuccessAt: lastGood ? (lastGood.finished_at ?? lastGood.started_at).toISOString() : null,
    lastRun: runView(row)
  });
};

/** Asks the connection to prove its credentials; the per-profile client keeps its own failure wording. */
export const proofGetHandler: ConnectionRouteHandler = async (connectionId) => {
  const found = calendarSourceFor(connectionId, "proof");
  if (found instanceof Response) return found;
  if (isRosterWithoutHandler(found.manifest, "proof")) return unsupported(found.manifest);
  const proof = providerConnectionHandlers(found.manifest.id)?.proof;
  const result = proof ? await proof() : await proveCalendarSource(found.manifest.id);
  return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
};

const saveSchema = z.object({
  calendars: z
    .array(
      z.object({
        calendarId: z.string().min(1).max(500),
        summary: z.string().min(1).max(500),
        selected: z.boolean()
      })
    )
    .max(200)
});

/**
 * The account's calendars as the connection lists them, each with whether it is ticked for the sync. Nothing is
 * ticked until chosen. When the proxy cannot be reached the saved choices still come back (marked by the
 * error), so the card can show what the sync is reading even while the provider is unreachable. When the
 * connection is not set up it answers 200 with `notConfigured: true` and the saved choices, since that is
 * a state rather than a failure.
 */
export const calendarsGetHandler: ConnectionRouteHandler = async (connectionId, _request, _context, log) => {
  const found = calendarsFor(connectionId);
  if (found instanceof Response) return found;
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Calendar choices require PostgreSQL." }, { status: 503 });
  const saved = await listGoogleCalendarSelections(sqlPool(connectionString));
  const selectedIds = new Set(saved.filter((row) => row.selected).map((row) => row.calendarId));
  try {
    const listed = await fetchGoogleCalendars();
    return Response.json({
      calendars: listed.map((calendar) => ({ ...calendar, selected: selectedIds.has(calendar.calendarId) }))
    });
  } catch (error) {
    const savedCalendars = saved.map((row) => ({
      calendarId: row.calendarId,
      summary: row.summary,
      selected: row.selected
    }));
    // Not set up is a state, not a failure: answer 200 so the browser logs no error, and say so.
    if ((error as { reason?: string } | null)?.reason === "not_configured")
      return Response.json({ calendars: savedCalendars, notConfigured: true });
    log.setError(error);
    return Response.json(
      {
        error: error instanceof Error ? redact(error.message) : `${found.manifest.label} could not be listed.`,
        reason: (error as { reason?: string } | null)?.reason,
        calendars: savedCalendars
      },
      { status: 502 }
    );
  }
};

/** Saves which calendars the sync reads. Body: `{ calendars: [{ calendarId, summary, selected }] }`. */
export const calendarsPutHandler: ConnectionRouteHandler = async (connectionId, request) => {
  const found = calendarsFor(connectionId);
  if (found instanceof Response) return found;
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Calendar choices require PostgreSQL." }, { status: 503 });
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Calendar choices are invalid.", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 }
    );
  const saved = await saveGoogleCalendarSelections(sqlPool(connectionString), parsed.data.calendars);
  return Response.json({ calendars: saved });
};

/**
 * Runs the publish sweep to a calendar sink: the worker's fifteen-minute fallback tick posts here with
 * `{trigger:"scheduled"}` and no `Origin` header, and "Publish now" on Connections posts `{trigger:"manual"}`
 * or no body. Every request also makes sure this process is listening for `state_changed`, which is the
 * sweep's main trigger.
 */
export const publishPostHandler: ConnectionRouteHandler = async (connectionId, request, _context, log) => {
  const found = calendarSinkFor(connectionId, "create");
  if (found instanceof Response) return found;
  ensureCalendarPublishSubscribed();
  const body = (await request.json().catch(() => null)) as { trigger?: unknown; approveDeletes?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";
  try {
    const approveDeletes =
      typeof body?.approveDeletes === "number" && Number.isInteger(body.approveDeletes) && body.approveDeletes > 0
        ? body.approveDeletes
        : undefined;
    const result = await found.publish.run({ trigger, ...(approveDeletes ? { approveDeletes } : {}) });
    return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : `The ${found.manifest.label} publish failed.` },
      { status: 400 }
    );
  }
};

/** The latest runs and the publication counts, for the Connections card to show without triggering a sweep. */
export const publishGetHandler: ConnectionRouteHandler = async (connectionId) => {
  const found = calendarSinkFor(connectionId, "create");
  if (found instanceof Response) return found;
  ensureCalendarPublishSubscribed();
  const connectionString = databaseUrl();
  if (!connectionString)
    return Response.json({ error: `${found.manifest.label} publish history requires PostgreSQL.` }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  return Response.json(await found.publish.status(sql, userId));
};

/**
 * "Remove everything OpenRhen published": deletes from the sink only the events recorded as published and
 * reports how many. Refuses without `{confirm:true}` so a stray request cannot empty the family's shared
 * events; the Connections button sends it after naming the count.
 */
export const publishRemoveHandler: ConnectionRouteHandler = async (connectionId, request, _context, log) => {
  const found = calendarSinkFor(connectionId, "remove");
  if (found instanceof Response) return found;
  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true)
    return Response.json({ error: "Removing published events requires confirm: true." }, { status: 400 });
  try {
    const result = await found.publish.removeAll();
    return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "Removing the published events failed." },
      { status: 400 }
    );
  }
};

/** Asks the sink to prove it can write: create, read back, update, delete a clearly-named test event. */
export const writeProofPostHandler: ConnectionRouteHandler = async (connectionId) => {
  const found = calendarSinkFor(connectionId, "write_proof");
  if (found instanceof Response) return found;
  const result = await found.publish.writeProof();
  return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
};

function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Independent of the portal's own planning horizon: recurring household events (school terms,
 * fortnightly appointments) are worth seeing several months out even when the plan itself only
 * looks a week or two ahead. */
const IMPORT_WINDOW_DAYS = 90;

/** Previews the events of a shared calendar (a source the portal also publishes to) as import candidates. */
export const importPreviewHandler: ConnectionRouteHandler = async (connectionId, request, _context, log) => {
  const found = calendarSourceFor(connectionId, "read_events");
  if (found instanceof Response) return found;
  const preview = providerConnectionHandlers(found.manifest.id)?.importPreview;
  if (!preview)
    return Response.json(
      { error: `${found.manifest.label} does not support that.`, reason: "unsupported_operation" },
      { status: 404 }
    );
  const body = (await request.json().catch(() => null)) as { mode?: unknown; timezone?: unknown } | null;
  if (
    !body ||
    (body.mode !== "new" && body.mode !== "updates") ||
    typeof body.timezone !== "string" ||
    !body.timezone ||
    body.timezone.length > 100
  )
    return Response.json({ error: `${found.manifest.label} import request is invalid.` }, { status: 400 });
  const now = new Date();
  const horizonEnd = new Date(now.getTime() + IMPORT_WINDOW_DAYS * 86_400_000);
  const dateStart = localDate(now, body.timezone);
  const dateEnd = localDate(horizonEnd, body.timezone);
  try {
    const { batch, message } = await preview({ mode: body.mode, timezone: body.timezone, dateStart, dateEnd });
    return Response.json({ batch, message: batch ? undefined : message });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : `${found.manifest.label} calendar preview failed.` },
      { status: 400 }
    );
  }
};
