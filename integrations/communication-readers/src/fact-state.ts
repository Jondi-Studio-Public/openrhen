import { isOpenStatus, resolveFactStatus, type FactStatus, type StatusActor, type StatusRow } from "./fact-status.js";

/**
 * Closure and age-out of derived facts (communication understanding, slice 2b-5): a pure fold, at read, of
 *   - the fact rows (several can share a `fact_id`; the row from the latest source message wins),
 *   - their `fact_status` and `override` rows (the person over Mark over an extractor),
 *   - their links (`cancel`, `reschedule`, `repeat`; resolved here, never stored as resolved),
 *   - and the later messages of the conversation,
 * into one state per fact: `open`, `reopened` (open again after a closing status), `closed` or `expired`; a row that is
 * only a link to another fact is `link` and is never listed. Nothing here is written: `expired` follows the clock and a
 * link follows the rows around it, so deleting a cancel message returns the event to open and deleting a target orphans
 * the link, which is then ignored.
 *
 * The rules, each a stated constant or comment below:
 *   - An ask is closed by a later `from_self` message in the same conversation, and expires `ASK_HORIZON_DAYS` after the
 *     last message in the conversation. A commitment has the same age-out but is not closed by his next message.
 *   - An event or deadline ends at its resolved time (the latest reading's end, else start; an ambiguous time keeps
 *     `AMBIGUOUS_TIME_GRACE_HOURS` more) and, with no resolved time, expires `NO_TIME_HORIZON_DAYS` after its source message.
 *   - A fact message later than the latest closing status (`done`, `cancelled`, `superseded`) reopens the fact.
 *   - A link row closes (`cancel`), moves (`reschedule`) or restarts (`repeat`) its target. It counts only when the
 *     target's message is strictly earlier than the link row's, follows a chain of at most `LINK_CHAIN_MAX` hops, and
 *     is void if the person or Mark closed the link row. A status from the person or Mark always beats a link; the
 *     link then shows as `updateSeen` and nothing is hidden.
 */

export const ASK_HORIZON_DAYS = 14;
export const NO_TIME_HORIZON_DAYS = 14;
export const AMBIGUOUS_TIME_GRACE_HOURS = 24;
export const LINK_CHAIN_MAX = 3;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FACT_TYPES = ["ask", "commitment", "event", "deadline"] as const;
const CLOSING: readonly FactStatus[] = ["done", "cancelled", "superseded"];
const RANK: Record<StatusActor, number> = { person: 3, mark: 2, extractor: 1 };

export type FactFoldState = "open" | "reopened" | "closed" | "expired" | "link";
export type FactClosedBy = "status" | "reply" | "link";

export interface FoldLink {
  relation: "cancel" | "reschedule" | "repeat";
  targetFactId: string;
}
export interface FoldWhen {
  candidates: readonly { start: string; end?: string | null | undefined }[];
  ambiguous: boolean;
}
export interface FoldFactRow {
  /** The row's event_key. */
  key: string;
  factId: string;
  factType: string;
  /** The source message's time (RFC 3339). */
  tsStart: string;
  /** The ICS SEQUENCE of the source message, when known: the tie-break between rows of one message time. */
  sequence?: number | null | undefined;
  sourceEventId?: string | null | undefined;
  conversationKey?: string | null | undefined;
  icsUid?: string | null | undefined;
  direction?: "in" | "out" | null | undefined;
  when?: FoldWhen | null | undefined;
  links?: readonly FoldLink[] | undefined;
}
export interface FoldStatus extends StatusRow {
  factId: string;
}
export interface FoldOverride {
  factId: string;
  /** `fact_type`, `when` and `direction` change the fold; any other field is display only and ignored here. */
  field: string;
  newValue: unknown;
  /** When the correction was recorded (RFC 3339); the latest of equal rank wins. */
  at: string;
  actor: StatusActor;
  key: string;
}
export interface FoldMessage {
  at: string;
  fromSelf: boolean;
}
export interface FoldInput {
  facts: readonly FoldFactRow[];
  statuses?: readonly FoldStatus[] | undefined;
  overrides?: readonly FoldOverride[] | undefined;
  /** The messages of each conversation, by conversation key. Only later messages matter, so older ones may be left out. */
  conversations?: Readonly<Record<string, readonly FoldMessage[]>> | undefined;
  now: Date;
}

export interface FactFold {
  factId: string;
  /** The winning row's event_key. */
  rowKey: string;
  sourceEventId: string | null;
  conversationKey: string | null;
  /** The type after the person's or Mark's correction. */
  factType: string;
  direction: "in" | "out" | null;
  tsStart: string;
  /** The later of the source message and the latest `repeat` of it: what ordering and the reply clock use. */
  recentAt: string;
  state: FactFoldState;
  /** `open` or `reopened`. */
  open: boolean;
  isLink: boolean;
  /** The winning status, `expired` when it aged out, or the status the closure implies (`done` for a reply, `cancelled` for a cancel). Null for a link row. */
  status: FactStatus | "expired" | null;
  closedBy: FactClosedBy | null;
  closedAt: string | null;
  /** Who made the winning fact_status (null when there is none). */
  actor: StatusActor | null;
  reopened: boolean;
  /** A link arrived that a status from the person or Mark overrode. */
  updateSeen: boolean;
  repeatedAt: string | null;
  /** The fact id of the reschedule row that moved this fact. */
  movedBy: string | null;
  /** When an event or deadline is due (its earliest reading); null for the others and when no time resolved. */
  dueAt: string | null;
  /** The end of an event or deadline with a resolved time, grace included; the instant it expires. */
  endsAt: string | null;
  /** The instant the fact ages out (null once closed). */
  expiresAt: string | null;
}

/** The actor of a fact_status or override row from the server-derived `ingested_via`: null is the person, `extractor:*` an extractor, any other agent is Mark. */
export function statusActorOf(ingestedVia: string | null): StatusActor {
  if (ingestedVia === null) return "person";
  return ingestedVia.startsWith("extractor:") ? "extractor" : "mark";
}

const NEG = Number.NEGATIVE_INFINITY;
const ms = (value: string | null | undefined): number => {
  const parsed = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? NEG : parsed;
};
const iso = (value: number): string => new Date(value).toISOString();
const isFactType = (value: unknown): value is (typeof FACT_TYPES)[number] =>
  typeof value === "string" && (FACT_TYPES as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface Reading {
  start: number;
  end: number | null;
}
interface Timing {
  readings: Reading[];
  ambiguous: boolean;
}

/** A `when` value from a row or an override: `{candidates, ambiguous}`, `{start, end?}`, a bare time, or null (no time). Undefined means unreadable. */
function timingOf(value: unknown): Timing | undefined {
  if (value === null) return { readings: [], ambiguous: false };
  if (typeof value === "string") {
    const start = ms(value);
    return start === NEG ? undefined : { readings: [{ start, end: null }], ambiguous: false };
  }
  if (!isRecord(value)) return undefined;
  const readings: Reading[] = [];
  const add = (candidate: unknown) => {
    if (!isRecord(candidate)) return;
    const start = ms(typeof candidate.start === "string" ? candidate.start : null);
    if (start === NEG) return;
    const end = ms(typeof candidate.end === "string" ? candidate.end : null);
    readings.push({ start, end: end === NEG || end < start ? null : end });
  };
  if (Array.isArray(value.candidates)) {
    value.candidates.forEach(add);
    return { readings, ambiguous: value.ambiguous === true || readings.length > 1 };
  }
  if (typeof value.start === "string") {
    add(value);
    return readings.length === 0 ? undefined : { readings, ambiguous: false };
  }
  return undefined;
}

function dueAndEnd(timing: Timing | null): { due: number | null; ends: number | null } {
  if (timing === null || timing.readings.length === 0) return { due: null, ends: null };
  const due = Math.min(...timing.readings.map((r) => r.start));
  const last = Math.max(...timing.readings.map((r) => r.end ?? r.start));
  return { due, ends: last + (timing.ambiguous ? AMBIGUOUS_TIME_GRACE_HOURS * HOUR_MS : 0) };
}

/** One row per fact id: the latest source message, then the higher ICS SEQUENCE, then the greater key. */
function better(a: FoldFactRow, b: FoldFactRow): boolean {
  const [x, y] = [ms(a.tsStart), ms(b.tsStart)];
  if (x !== y) return x > y;
  const [s, t] = [a.sequence ?? NEG, b.sequence ?? NEG];
  if (s !== t) return s > t;
  return a.key > b.key;
}

/** The winning override of one field: the person's over Mark's over an extractor's, then the latest, then the greater key. */
function winningOverride(rows: readonly FoldOverride[], field: string): FoldOverride | undefined {
  let best: FoldOverride | undefined;
  for (const row of rows) {
    if (row.field !== field) continue;
    if (best === undefined) {
      best = row;
      continue;
    }
    const [r, q] = [RANK[row.actor], RANK[best.actor]];
    if (r !== q ? r > q : ms(row.at) !== ms(best.at) ? ms(row.at) > ms(best.at) : row.key > best.key) best = row;
  }
  return best;
}

interface Effective {
  row: FoldFactRow;
  ts: number;
  type: string;
  direction: "in" | "out" | null;
  timing: Timing | null;
  isLink: boolean;
}

interface Effect {
  relation: FoldLink["relation"];
  by: Effective;
}

/**
 * The state of every fact in the input. One entry per fact id, in no particular order; `openFacts` filters and orders them.
 * Pure: the same rows give the same states whatever order they arrive in.
 */
export function foldFactStates(input: FoldInput): FactFold[] {
  const now = input.now.getTime();
  const winners = new Map<string, FoldFactRow>();
  for (const row of input.facts) {
    const held = winners.get(row.factId);
    if (held === undefined || better(row, held)) winners.set(row.factId, row);
  }
  const statusesBy = new Map<string, FoldStatus[]>();
  for (const status of input.statuses ?? [])
    statusesBy.set(status.factId, [...(statusesBy.get(status.factId) ?? []), status]);
  const overridesBy = new Map<string, FoldOverride[]>();
  for (const item of input.overrides ?? [])
    overridesBy.set(item.factId, [...(overridesBy.get(item.factId) ?? []), item]);

  const effective = new Map<string, Effective>();
  for (const [factId, row] of winners) {
    const overrides = overridesBy.get(factId) ?? [];
    const typeOverride = winningOverride(overrides, "fact_type")?.newValue;
    const directionOverride = winningOverride(overrides, "direction")?.newValue;
    const whenOverride = winningOverride(overrides, "when");
    const timing = whenOverride === undefined ? undefined : timingOf(whenOverride.newValue);
    effective.set(factId, {
      row,
      ts: ms(row.tsStart),
      type: isFactType(typeOverride) ? typeOverride : row.factType,
      direction:
        directionOverride === "in" || directionOverride === "out" ? directionOverride : (row.direction ?? null),
      timing: timing !== undefined ? timing : (timingOf(row.when ?? null) ?? null),
      isLink: (row.links?.length ?? 0) > 0
    });
  }

  // A status fold without expiry or links: used for a fact's own status and to see whether a link row was closed.
  const statusFold = (factId: string, rowTs: number) => {
    const all = statusesBy.get(factId) ?? [];
    // A fact message later than the closing status reopens the fact: those closings no longer count.
    const kept = all.filter((s) => !CLOSING.includes(s.status) || ms(s.validFrom) >= rowTs);
    const reopened = kept.length < all.length;
    return { resolved: resolveFactStatus(kept, { now: input.now }), reopened };
  };
  const voided = (link: Effective): boolean => {
    const { resolved } = statusFold(link.row.factId, link.ts);
    return resolved.row !== null && CLOSING.includes(resolved.status as FactStatus);
  };

  // Where a link's target is: its id, else the same ICS uid, else the only event or deadline in the conversation.
  const targetsOf = (from: Effective, link: FoldLink): Effective[] => {
    const named = effective.get(link.targetFactId);
    if (named !== undefined) return named.row.factId === from.row.factId ? [] : [named];
    const earlier = [...effective.values()].filter(
      (other) => !other.isLink && other.row.factId !== from.row.factId && other.ts < from.ts
    );
    if (from.row.icsUid) {
      const sameUid = earlier.filter((other) => other.row.icsUid === from.row.icsUid);
      if (sameUid.length > 0) return sameUid;
    }
    if (from.row.conversationKey) {
      const sameConversation = earlier.filter(
        (other) =>
          other.row.conversationKey === from.row.conversationKey &&
          (other.type === "event" || other.type === "deadline")
      );
      if (sameConversation.length === 1) return sameConversation;
    }
    return [];
  };

  const effects = new Map<string, Effect[]>();
  // `relation` is the outermost link's: a cancel that names a reschedule row cancels the event that row moved.
  const walk = (outer: Effective, from: Effective, relation: FoldLink["relation"] | null, hop: number) => {
    for (const link of from.row.links ?? []) {
      for (const target of targetsOf(from, link)) {
        // Strictly earlier: a link can never point at itself, forward in time, or round a loop.
        if (!(target.ts < from.ts)) continue;
        if (target.isLink) {
          if (hop < LINK_CHAIN_MAX && !voided(target)) walk(outer, target, relation ?? link.relation, hop + 1);
          continue;
        }
        const list = effects.get(target.row.factId) ?? [];
        list.push({ relation: relation ?? link.relation, by: outer });
        effects.set(target.row.factId, list);
      }
    }
  };
  for (const item of effective.values()) if (item.isLink && !voided(item)) walk(item, item, null, 1);

  const folds: FactFold[] = [];
  for (const [factId, item] of effective) {
    const { row } = item;
    const base = {
      factId,
      rowKey: row.key,
      sourceEventId: row.sourceEventId ?? null,
      conversationKey: row.conversationKey ?? null,
      factType: item.type,
      direction: item.direction,
      tsStart: row.tsStart
    };
    if (item.isLink) {
      folds.push({
        ...base,
        recentAt: row.tsStart,
        state: "link",
        open: false,
        isLink: true,
        status: null,
        closedBy: null,
        closedAt: null,
        actor: null,
        reopened: false,
        updateSeen: false,
        repeatedAt: null,
        movedBy: null,
        dueAt: null,
        endsAt: null,
        expiresAt: null
      });
      continue;
    }

    const { resolved, reopened: droppedClosing } = statusFold(factId, item.ts);
    const winner = resolved.row;
    const explicit = winner !== null && (winner.actor === "person" || winner.actor === "mark");
    const mine = [...(effects.get(factId) ?? [])].sort(
      (a, b) => a.by.ts - b.by.ts || (a.by.row.factId < b.by.row.factId ? -1 : 1)
    );
    const repeats = mine.filter((e) => e.relation === "repeat");
    const decisive = mine.filter((e) => e.relation !== "repeat").at(-1);
    const repeatMs = repeats.length === 0 ? NEG : Math.max(...repeats.map((e) => e.by.ts));
    const effectiveTs = Math.max(item.ts, repeatMs);
    const recentAt = iso(effectiveTs);

    let state: FactFoldState = "open";
    let status: FactFold["status"] = resolved.status;
    let closedBy: FactClosedBy | null = null;
    let closedAt: string | null = null;
    let movedBy: string | null = null;
    let timing = item.timing;
    let timeBase = item.ts;
    let updateSeen = false;

    if (!isOpenStatus(resolved.status)) {
      state = "closed";
      closedBy = "status";
      closedAt = winner?.validFrom ?? null;
      updateSeen = explicit && decisive !== undefined;
    } else if (decisive !== undefined && explicit) {
      updateSeen = true;
    } else if (decisive?.relation === "cancel") {
      state = "closed";
      status = "cancelled";
      closedBy = "link";
      closedAt = decisive.by.row.tsStart;
    } else if (decisive?.relation === "reschedule") {
      // The target stays open at the time the reschedule row resolved to; with none, the old time is stale.
      movedBy = decisive.by.row.factId;
      timing = decisive.by.timing ?? { readings: [], ambiguous: false };
      timeBase = decisive.by.ts;
      status = "rescheduled";
    }

    const askLike = item.type === "ask" || item.type === "commitment";
    const messages = (input.conversations?.[row.conversationKey ?? ""] ?? []).map((m) => ({
      at: ms(m.at),
      fromSelf: m.fromSelf
    }));

    if (state !== "closed" && item.type === "ask" && item.direction !== "out") {
      const reply = messages
        .filter((m) => m.fromSelf && m.at > effectiveTs)
        .reduce<number | null>((first, m) => (first === null || m.at < first ? m.at : first), null);
      // A person's or Mark's explicit statement made after the reply says it is still open.
      if (reply !== null && !(explicit && winner !== null && ms(winner.validFrom) >= reply)) {
        state = "closed";
        status = "done";
        closedBy = "reply";
        closedAt = iso(reply);
      }
    }

    let expiresMs: number;
    let due: number | null = null;
    let timedEnd: number | null = null;
    if (askLike) {
      const lastMessage = messages.reduce((latest, m) => Math.max(latest, m.at), NEG);
      expiresMs = Math.max(effectiveTs, lastMessage) + ASK_HORIZON_DAYS * DAY_MS;
    } else {
      const times = dueAndEnd(timing);
      due = times.due;
      timedEnd = times.ends;
      expiresMs = timedEnd ?? Math.max(timeBase, repeatMs) + NO_TIME_HORIZON_DAYS * DAY_MS;
    }
    // A status row can carry its own end (a person's reschedule); like resolveFactStatus, it wins.
    const ownEnd = ms(winner?.expiresAt);
    if (ownEnd !== NEG) expiresMs = ownEnd;

    if (state !== "closed" && now >= expiresMs) {
      state = "expired";
      status = "expired";
    }
    const open = state === "open";
    const reopened = open && droppedClosing;
    folds.push({
      ...base,
      recentAt,
      state: reopened ? "reopened" : state,
      open,
      isLink: false,
      status,
      closedBy,
      closedAt,
      actor: winner?.actor ?? null,
      reopened,
      updateSeen,
      repeatedAt: repeatMs === NEG ? null : iso(repeatMs),
      movedBy,
      dueAt: due === null ? null : iso(due),
      endsAt: timedEnd === null ? null : iso(timedEnd),
      expiresAt: state === "closed" || !Number.isFinite(expiresMs) ? null : iso(expiresMs)
    });
  }
  return folds;
}

/** Soonest timed event or deadline first; then asks, commitments and untimed items, newest first. A total order: ties fall to the fact id. */
export function compareOpenFacts(a: FactFold, b: FactFold): number {
  const [x, y] = [a.dueAt === null ? null : ms(a.dueAt), b.dueAt === null ? null : ms(b.dueAt)];
  if (x !== null && y !== null && x !== y) return x - y;
  if ((x === null) !== (y === null)) return x === null ? 1 : -1;
  const [p, q] = [ms(a.recentAt), ms(b.recentAt)];
  if (p !== q) return q - p;
  return a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
}

/** The open (and reopened) facts, in `compareOpenFacts` order. Closed, expired and link rows are left out. */
export function openFacts(folds: readonly FactFold[]): FactFold[] {
  return folds.filter((fold) => fold.open).sort(compareOpenFacts);
}
