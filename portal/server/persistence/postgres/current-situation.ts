/** Reading and updating the momentary "where I am and what I have" record on user preferences. */
import {
  currentSituationSchema,
  personPresenceSchema,
  requirementWaiverSchema,
  stampPresence,
  stretchDeclineSchema,
  stretchRecordSchema,
  stretchStateSchema,
  type PersonPresence,
  type RequirementWaiver,
  type StretchState,
  transportModeSchema
} from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import type { Sql } from "./sql-pool";

/** The canonical set every "no transport modes stored" situation defaults to; see `parseCurrentSituation`. */
const ALL_TRANSPORT_MODES = transportModeSchema.options;
type TransportMode = (typeof ALL_TRANSPORT_MODES)[number];

/** Keeps only recognised modes, in no particular order; literal — callers decide what an empty result means. */
function filterTransportModes(value: unknown): TransportMode[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is TransportMode => ALL_TRANSPORT_MODES.includes(entry as TransportMode))
    : [];
}

/**
 * Pure rule for a recorded wake: the person slept where they last said they were, so waking there is
 * a fresh assertion of that location as of the wake time. Nothing is invented — with no location
 * set, none appears — and it only ever moves the assertion forward, so logging an older sleep after
 * a newer assertion changes nothing. Returns the unchanged object when there is nothing to do.
 */
export function situationAfterWake(
  situation: PortalState["currentSituation"],
  wakeAt: Date
): PortalState["currentSituation"] {
  if (situation.locationId === null) return situation;
  const setAt = situation.locationSetAt ? new Date(situation.locationSetAt).getTime() : Number.NEGATIVE_INFINITY;
  if (!(setAt < wakeAt.getTime())) return situation;
  return { ...situation, locationSetAt: wakeAt.toISOString() };
}

/** Applies `situationAfterWake` to the stored record inside the caller's transaction. */
export async function reassertLocationOnWake(tx: Sql, userId: string, wakeAt: Date): Promise<void> {
  const rows = await tx<
    { current_situation: unknown }[]
  >`SELECT current_situation FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
  if (!rows[0]) return;
  const before = parseCurrentSituation(rows[0].current_situation);
  const after = situationAfterWake(before, wakeAt);
  if (after === before) return;
  await tx`UPDATE user_preferences SET current_situation=${tx.json(after as never)},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
}

function defaultCurrentSituation(): PortalState["currentSituation"] {
  return {
    locationId: null,
    overrides: {},
    carrying: {},
    transportModes: [...ALL_TRANSPORT_MODES],
    travel: {},
    travelOff: false
  };
}
/**
 * The per-destination `travel` cache and its `travelRefreshedAt` clock are retired
 * a live reading now comes from the request's
 * journey summary (`journey_samples`, read through `readJourneySummary`), not from anything stored
 * here. Both fields stay declared on the contract schema so a value stored before this migration still
 * parses (`context-model.ts`), but this reader never reconstructs them from storage any more — `travel`
 * always reads back empty and `travelRefreshedAt` is always absent, whatever the stored JSON carries.
 */
export function parseCurrentSituation(value: unknown): PortalState["currentSituation"] {
  if (!value || typeof value !== "object") return defaultCurrentSituation();
  const raw = value as Record<string, unknown>;
  const overrides: Record<string, "available" | "unavailable"> = {};
  if (raw.overrides && typeof raw.overrides === "object")
    for (const [key, entry] of Object.entries(raw.overrides as Record<string, unknown>))
      if (entry === "available" || entry === "unavailable") overrides[key] = entry;
  const carrying: Record<string, boolean> = {};
  if (raw.carrying && typeof raw.carrying === "object")
    for (const [key, entry] of Object.entries(raw.carrying as Record<string, unknown>))
      if (typeof entry === "boolean") carrying[key] = entry;
  // Never configured means unconstrained, not "cannot leave the house": a record written before
  // travel existed, or one nothing has ever asked, must not read the same as a person who deliberately
  // unticked every mode. The two are indistinguishable once stored, so a *stored* empty array defaults
  // to every mode here — the read layer's job, not the engine's. `nextCurrentSituation` below parses an
  // incoming *write* the same way but keeps its literal, undefaulted result, so a person who does
  // explicitly untick every box can still save that choice (refused entirely by the write schema now,
  // see `entity-commands.ts`'s `current_availability` handling) — only a value already sitting in
  // storage gets the benefit of the doubt.
  const storedModes = filterTransportModes(raw.transportModes);
  const transportModes = storedModes.length ? storedModes : [...ALL_TRANSPORT_MODES];
  const stretch = parseStretch(raw.stretch);
  const presence = parseEntries(raw.presence, personPresenceSchema);
  const waivers = parseEntries(raw.waivers, requirementWaiverSchema);
  return {
    locationId: typeof raw.locationId === "string" ? raw.locationId : null,
    ...(typeof raw.locationSetAt === "string" ? { locationSetAt: raw.locationSetAt } : {}),
    ...(parseEnergySetAt(raw.energySetAt) !== undefined ? { energySetAt: parseEnergySetAt(raw.energySetAt) } : {}),
    ...(stretch !== undefined ? { stretch } : {}),
    overrides,
    ...(presence ? { presence } : {}),
    ...(waivers ? { waivers } : {}),
    carrying,
    transportModes,
    travel: {},
    travelOff: typeof raw.travelOff === "boolean" ? raw.travelOff : false,
    ...(parseUnderway(raw.underway) !== undefined ? { underway: parseUnderway(raw.underway) } : {})
  };
}

/** Entry by entry, so one bad record costs only itself; `undefined` when nothing valid is left. */
function parseEntries<T>(
  value: unknown,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }
): Record<string, T> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kept: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = schema.safeParse(entry);
    if (key && parsed.success) kept[key] = parsed.data;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Safety expiry for a waiver ("do it without them"). It is one-time: it stops counting once the work it covers is
 * completed after it was said (`waiver-consumption.ts`); this only clears one that was never used.
 */
export const WAIVER_DAYS = 7;
/** Most people and waivers kept at once; the oldest give way. */
const MAX_PRESENCE = 50;
const MAX_WAIVERS = 50;

/**
 * Presence after a save. Only a verb (`"here"`, `"away"`, or `null` to clear) says anything: it is stamped by the
 * server's clock to the end of the owner's local day. A stored-looking object in the payload is never read, so a
 * whole situation resent by a client or the CLI can neither create nor extend one. What has run out is dropped.
 */
export function nextPresence(
  previous: Record<string, PersonPresence> | undefined,
  raw: Record<string, unknown>,
  now: Date,
  timeZone: string
): Record<string, PersonPresence> | undefined {
  const kept: Record<string, PersonPresence> = {};
  for (const [id, entry] of Object.entries(previous ?? {}))
    if (Date.parse(entry.until) > now.getTime()) kept[id] = entry;
  const said = raw.presence && typeof raw.presence === "object" ? (raw.presence as Record<string, unknown>) : {};
  for (const [id, verb] of Object.entries(said)) {
    if (!id) continue;
    if (verb === null) delete kept[id];
    else if (verb === "here" || verb === "away") kept[id] = stampPresence(verb, now, timeZone);
  }
  const entries = Object.entries(kept).sort(([, a], [, b]) => a.setAt.localeCompare(b.setAt));
  const limited = Object.fromEntries(entries.slice(-MAX_PRESENCE));
  return Object.keys(limited).length ? limited : undefined;
}

/** Waivers after a save: a list of contact ids stamps one for that work, `null` removes it, an object is never read. */
export function nextWaivers(
  previous: Record<string, RequirementWaiver> | undefined,
  raw: Record<string, unknown>,
  now: Date
): Record<string, RequirementWaiver> | undefined {
  const kept: Record<string, RequirementWaiver> = {};
  for (const [id, entry] of Object.entries(previous ?? {}))
    if (Date.parse(entry.until) > now.getTime()) kept[id] = entry;
  const said = raw.waivers && typeof raw.waivers === "object" ? (raw.waivers as Record<string, unknown>) : {};
  for (const [workId, people] of Object.entries(said)) {
    if (!workId) continue;
    if (people === null) delete kept[workId];
    else if (Array.isArray(people)) {
      const ids = [...new Set(people.filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (ids.length)
        kept[workId] = {
          people: ids.slice(0, 12),
          setAt: now.toISOString(),
          until: new Date(now.getTime() + WAIVER_DAYS * DAY_MS).toISOString()
        };
    }
  }
  const entries = Object.entries(kept).sort(([, a], [, b]) => a.setAt.localeCompare(b.setAt));
  const limited = Object.fromEntries(entries.slice(-MAX_WAIVERS));
  return Object.keys(limited).length ? limited : undefined;
}

/** Strict like `parseUnderway`: only a real ISO datetime counts as when energy was said. */
function parseEnergySetAt(value: unknown): string | undefined {
  const parsed = currentSituationSchema.shape.energySetAt.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Entry by entry, so one bad record never costs the rest (or the whole situation): bad entries are
 * dropped, and `undefined` comes back when nothing is left.
 */
function parseStretch(value: unknown): StretchState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const accepted = (Array.isArray(raw.accepted) ? raw.accepted : []).flatMap((entry) => {
    const parsed = stretchRecordSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const declined = (Array.isArray(raw.declined) ? raw.declined : []).flatMap((entry) => {
    const parsed = stretchDeclineSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const declinedAllAt = stretchStateSchema.shape.declinedAllAt.safeParse(raw.declinedAllAt);
  // Newest kept at the schema's caps, so an over-long stored list can never fail the engine request.
  accepted.splice(0, Math.max(0, accepted.length - 30));
  declined.splice(0, Math.max(0, declined.length - 50));
  if (!accepted.length && !declined.length && !declinedAllAt.data) return undefined;
  return {
    accepted,
    declined,
    ...(declinedAllAt.data ? { declinedAllAt: declinedAllAt.data } : {})
  };
}

const DAY_MS = 86_400_000;

/**
 * Drops what no longer matters: loan records whose `until` is over a week old, declines and "no
 * stretches" older than two days; then caps the lists (oldest first). Pure; `undefined` when empty.
 */
export function pruneStretch(stretch: StretchState | undefined, now: Date): StretchState | undefined {
  if (!stretch) return undefined;
  const acceptedCutoff = now.getTime() - 7 * DAY_MS;
  const declineCutoff = now.getTime() - 2 * DAY_MS;
  const accepted = stretch.accepted
    .filter((entry) => new Date(entry.until).getTime() >= acceptedCutoff)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))
    .slice(-30);
  const declined = stretch.declined
    .filter((entry) => new Date(entry.at).getTime() >= declineCutoff)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-50);
  const declinedAllAt =
    stretch.declinedAllAt && new Date(stretch.declinedAllAt).getTime() >= declineCutoff
      ? stretch.declinedAllAt
      : undefined;
  if (!accepted.length && !declined.length && !declinedAllAt) return undefined;
  return { accepted, declined, ...(declinedAllAt ? { declinedAllAt } : {}) };
}

/**
 * `null` (explicitly cleared or absent) is a valid, distinct outcome from `undefined` (field never named).
 * Strict, by the contract's own schema: a departure or start time that is not an ISO datetime with an
 * offset would otherwise be stored and later throw inside `recordOwnTripOnArrival`.
 */
function parseUnderway(value: unknown): PortalState["currentSituation"]["underway"] | undefined {
  const parsed = currentSituationSchema.shape.underway.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A client that only knows the legacy assertedConditions/currentEnergy shape sends no `currentSituation`
 * at all, so the stored value must pass through unchanged. Overrides are momentary and are cleared on
 * a location change (see context-model.ts); carrying is durable and is only replaced when supplied.
 */
export function nextCurrentSituation(
  previous: PortalState["currentSituation"],
  incomingRaw: unknown,
  options: { now?: Date; timeZone?: string } = {}
): PortalState["currentSituation"] {
  if (!incomingRaw || typeof incomingRaw !== "object") return previous;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "UTC";
  const raw = incomingRaw as Record<string, unknown>;
  const parsed = parseCurrentSituation(raw);
  const nextLocationId = "locationId" in raw ? parsed.locationId : previous.locationId;
  const locationChanged = nextLocationId !== previous.locationId;
  // Naming a location asserts being there now, so re-confirming the same one refreshes the clock.
  // Without this there is no way out of a stale location except changing away and back, and staleness
  // is what withdraws every location-derived capability.
  const locationAsserted = "locationId" in raw && parsed.locationId !== null;
  const presence = nextPresence(previous.presence, raw, now, timeZone);
  const waivers = nextWaivers(previous.waivers, raw, now);
  return {
    locationId: nextLocationId,
    locationSetAt:
      locationChanged || locationAsserted
        ? new Date().toISOString()
        : (previous.locationSetAt ?? new Date().toISOString()),
    // A partial update (e.g. just the location) must not silently wipe overrides/carrying the caller
    // never mentioned; only a key actually present in the payload replaces the stored value.
    overrides: locationChanged ? {} : "overrides" in raw ? parsed.overrides : previous.overrides,
    // Who is with the owner, and what was waived, outlive a change of place: walking to the garage does not make
    // Pete leave. Only a verb in this payload changes them (stamped here), and what has run out is dropped.
    ...(presence ? { presence } : {}),
    ...(waivers ? { waivers } : {}),
    carrying: "carrying" in raw ? parsed.carrying : previous.carrying,
    // Literal, not `parsed.transportModes`: a save that explicitly names this field is a deliberate
    // choice, including choosing none, and must persist exactly what was sent rather than have the
    // read-layer's "empty means never configured" default overwrite it back to every mode.
    transportModes: "transportModes" in raw ? filterTransportModes(raw.transportModes) : previous.transportModes,
    // Retired: a live reading now comes from the
    // journey store, not from a per-destination cache seeded off the leg just travelled. `travel` is
    // always empty and `travelRefreshedAt` is never written, whatever the incoming payload names.
    travel: {},
    // A save that explicitly names this field is a deliberate choice, same as `transportModes` above;
    // anything else keeps the stored value.
    travelOff: "travelOff" in raw && typeof raw.travelOff === "boolean" ? raw.travelOff : previous.travelOff,
    // Only the energy write dates energy (`entity-commands.ts`, on the server's clock): whatever the
    // payload carries back, including a whole stored situation resent, is ignored.
    ...(previous.energySetAt !== undefined ? { energySetAt: previous.energySetAt } : {}),
    // Same for the stretch answers: only the stretch command writes them, never a situation payload.
    ...(previous.stretch !== undefined ? { stretch: previous.stretch } : {}),
    underway: nextUnderway(previous.underway, raw, nextLocationId, locationAsserted)
  };
}

/**
 * On my way: an explicit `underway` in the payload (the
 * On my way button's own write) sets or clears it outright, a set one stamped with the server's `departedAt`. Otherwise it survives every ordinary
 * situation save unless *this* save asserts a place other than its own `fromLocationId` — a
 * same-place refresh (the phone's staleness-only ping, a manual re-pick of the same place) must not
 * clear it, only a genuine move (another place, or arrival at the destination) does.
 */
function nextUnderway(
  previous: PortalState["currentSituation"]["underway"],
  raw: Record<string, unknown>,
  nextLocationId: string | null,
  locationAsserted: boolean
): PortalState["currentSituation"]["underway"] {
  if ("underway" in raw) {
    const parsed = parseUnderway(raw.underway);
    if (parsed === undefined) return previous ?? null;
    if (parsed === null) return null;
    // A whole-situation save (the CLI's `save current_availability`) re-sends the stored underway: the same
    // trip keeps its departure. Otherwise the server's clock is the departure, never the client's, since
    // this value feeds own-trip samples.
    const sameTrip =
      previous &&
      previous.commitmentId === parsed.commitmentId &&
      previous.occurrenceStartsAt === parsed.occurrenceStartsAt &&
      previous.fromLocationId === parsed.fromLocationId;
    return { ...parsed, departedAt: sameTrip ? previous.departedAt : new Date().toISOString() };
  }
  if (!previous) return null;
  if (locationAsserted && nextLocationId !== previous.fromLocationId) return null;
  return previous;
}

/**
 * Called when an action is marked done: its waiver is used up there and then, so reopening it later is held
 * again. (A completed occurrence has no such moment to hook, so the read above covers it.) No row changes when
 * there is no waiver on it.
 */
export async function dropWaiverFor(tx: Sql, actionId: string): Promise<void> {
  await tx`UPDATE user_preferences up SET current_situation = current_situation #- ARRAY['waivers', ${actionId}::text]
    WHERE current_situation #> ARRAY['waivers', ${actionId}::text] IS NOT NULL
      AND EXISTS (SELECT 1 FROM actions ac JOIN projects p ON p.id=ac.project_id JOIN outcomes o ON o.id=p.outcome_id
        JOIN areas ar ON ar.id=o.area_id WHERE ac.id::text=${actionId} AND ar.user_id=up.user_id)`;
}
