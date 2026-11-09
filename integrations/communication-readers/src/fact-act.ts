import {
  RESCHEDULE_MAX_DAYS,
  STATUS_HOLD_MAX_DAYS,
  foldFactStates,
  winningOverride,
  type FactFold,
  type FoldFactRow,
  type FoldInput,
  type FoldOverride,
  type FoldStatus
} from "./fact-state.js";

/**
 * What Mark may do to an open fact (communication understanding, slice 2b-9, room `facts`): one pure planner from the
 * request and the rows the fold already reads to the rows to write, or to a refusal that says why and what to call
 * next. The route is I/O only. Nothing here reads mail text and no answer echoes any: a fact is named by its type and
 * the first eight characters of its id.
 *
 *   confirm  hold an ask or commitment open: expires_at = max(now + N days, the current expiry), N 1 to 30 (default 14)
 *   done     the thing was handled                     (fact_status done)        needs basis stated + the owner's words
 *   ignore   not a task / not wanted                   (fact_status cancelled)   needs basis stated + the owner's words
 *   redate   an event's or deadline's time is wrong    (override of `when`)      needs basis stated + the owner's words
 *   reopen   take back Mark's own mark: a hold, a done or an ignore (status proposed), and a redate (restores the time the
 *            extractor read); never over the owner's word and never over an ask the owner already answered
 *
 * Guards: the owner's word stands; only an open fact can be acted on (reopen and a corrective redate may also act on a
 * fact that is expired only because of Mark's own redate); every row gets a valid_from strictly after the fact's latest
 * status; closings are limited per agent (rows already read: nothing is counted from a second query); and a plan is
 * simulated through the fold, so an action that would change nothing is refused instead of reported as done.
 */

export const FACT_ACTS = ["confirm", "done", "ignore", "redate", "reopen"] as const;
export type FactAct = (typeof FACT_ACTS)[number];
/** An ask or commitment held open without `days`. The ask would age out after 14 days anyway. */
export const FACT_HOLD_DEFAULT_DAYS = 14;
/** The longest hold Mark may set (the contract allows 90 for a person). */
export const FACT_HOLD_MAX_DAYS = 30;
export const FACT_CLOSINGS_PER_HOUR = 5;
export const FACT_CLOSINGS_PER_DAY = 15;
export const FACT_WRITES_PER_HOUR = 10;
/** A hold on the same fact is made once a day: a repeat only churns the ledger. */
export const FACT_CONFIRMS_PER_FACT_PER_DAY = 1;
/** `until` of a redate is at most this many days after `when`. */
export const FACT_REDATE_SPAN_MAX_DAYS = 7;
/** The longest the owner's words are kept on a row (the basis/evidence limit of the tools). */
export const FACT_EVIDENCE_MAX = 300;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FACT_ID = /^[0-9a-f]{40}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const LIST_CALL = 'rhen_inbox {"room":"facts"}';
const HIDING: readonly FactAct[] = ["done", "ignore", "redate"];

export type FactActRefusal =
  | "unknown_action"
  | "bad_id"
  | "no_agent"
  | "not_found"
  | "not_open"
  | "owner_decided"
  | "wrong_type"
  | "bad_params"
  | "needs_stated"
  | "rate"
  | "no_mark"
  | "answered"
  | "no_effect";

/** A row for the caller to insert as `source: "derived"`; `validFrom` is also its `ts_start`. */
export interface PlannedRow {
  kind: "fact_status" | "override";
  validFrom: string;
  attrs: Record<string, unknown>;
}

export type FactActPlan =
  | {
      ok: true;
      act: FactAct;
      factId: string;
      /** The rows to write, in order. */
      rows: PlannedRow[];
      /** What to tell the caller, with the exact undo. */
      message: string;
    }
  | { ok: false; code: FactActRefusal; message: string };

export interface FactHistoryEntry {
  /** When the receipt was claimed (RFC 3339). */
  at: string;
  /** The action (`confirm`, `done`, ...), from the receipt's command type. */
  act: string;
  factId: string | null;
}

export interface FactActInput {
  /** As sent; checked against `FACT_ACTS`. */
  action: string;
  factId: string;
  /** The authenticated agent name (never from the client's body). Empty is refused. */
  by: string;
  /** Taken before the lock wait. */
  now: Date;
  /** The `set` values as sent (`days`, or `when` and `until`). */
  set: Readonly<Record<string, unknown>>;
  basis?: string | undefined;
  evidence?: string | undefined;
  /**
   * This agent's earlier marks from the write ledger (the receipts, which an undo does not remove), newest or oldest in any
   * order. When given, the limits count these, so undoing a mark never frees its place; when absent (a pure test), they
   * count the agent's rows in `fold`.
   */
  history?: readonly FactHistoryEntry[] | undefined;
  /** Every row the open-facts read holds, with `by`, `act` and `ingestedAt` on the status and override rows. */
  fold: FoldInput;
}

const cut = (value: unknown, max = 40): string =>
  // Anything outside printable ASCII becomes "?", so an echoed argument is never a vehicle for text.
  String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);

const ms = (value: string | null | undefined): number => (value ? Date.parse(value) : Number.NaN);
const minute = (value: number | string): string => `${new Date(value).toISOString().slice(0, 16)}Z`;
const refuse = (code: FactActRefusal, message: string): FactActPlan => ({ ok: false, code, message });
const unchanged = "Nothing was changed.";

const isAct = (value: string): value is FactAct => (FACT_ACTS as readonly string[]).includes(value);

const labelOf = (fold: FactFold): string => `${fold.factType} ${fold.factId.slice(0, 8)}`;
const reopenCall = (factId: string) => `rhen_inbox_act {"room":"facts","action":"reopen","id":"${factId}"}`;

function allowedKeys(action: FactAct): readonly string[] {
  return action === "confirm" ? ["days"] : action === "redate" ? ["when", "until"] : [];
}

/** Why a fact is not open, in words with no mail text. */
function whyNotOpen(fold: FactFold): string {
  if (fold.isLink) return "a later mail replaced it";
  if (fold.state === "expired") return `it expired on ${fold.expiresAt ? minute(fold.expiresAt) : "its date"}`;
  if (fold.closedBy === "reply") return `the owner replied in the conversation at ${minute(fold.closedAt ?? "")}`;
  if (fold.closedBy === "link") return `a later mail ${fold.status === "cancelled" ? "cancelled" : "closed"} it`;
  const who = fold.actor === "person" ? "the owner" : fold.actor === "mark" ? "an agent" : "the system";
  return `marked ${fold.status ?? "closed"} by ${who}${fold.closedAt ? ` at ${minute(fold.closedAt)}` : ""}`;
}

const isClosingStatus = (s: FoldStatus) =>
  s.act !== undefined && s.act !== null
    ? s.act === "done" || s.act === "ignore"
    : s.status === "done" || s.status === "cancelled";
const isClosingOverride = (o: FoldOverride) =>
  o.field === "when" && (o.act === undefined || o.act === null ? true : o.act === "redate");

/** The recording times of this agent's rows, closings apart; from the rows the fold already holds. */
function agentRows(fold: FoldInput, by: string, history?: readonly FactHistoryEntry[]) {
  if (history !== undefined)
    return history
      .map((entry) => ({ at: ms(entry.at), closing: HIDING.includes(entry.act as FactAct) }))
      .filter((row) => Number.isFinite(row.at));
  const all: { at: number; closing: boolean }[] = [];
  for (const s of fold.statuses ?? [])
    if (s.by === by && s.actor === "mark") all.push({ at: ms(s.ingestedAt), closing: isClosingStatus(s) });
  for (const o of fold.overrides ?? [])
    if (o.by === by && o.actor === "mark") all.push({ at: ms(o.at), closing: isClosingOverride(o) });
  return all.filter((row) => Number.isFinite(row.at));
}

function rateRefusal(
  action: FactAct,
  fold: FoldInput,
  by: string,
  nowMs: number,
  history: readonly FactHistoryEntry[] | undefined,
  factId: string
): FactActPlan | null {
  const rows = agentRows(fold, by, history);
  if (action === "confirm" && history !== undefined) {
    const again = history.filter(
      (entry) => entry.act === "confirm" && entry.factId === factId && ms(entry.at) > nowMs - DAY_MS
    );
    if (again.length >= FACT_CONFIRMS_PER_FACT_PER_DAY)
      return refuse(
        "rate",
        `You already held this item open in the last day, and a hold is made once a day for each item. ${unchanged} It stays held until its date; leave it, or ask the owner if it should be held longer.`
      );
  }
  const within = (windowMs: number, only?: "closing") =>
    rows.filter((row) => row.at > nowMs - windowMs && row.at <= nowMs + HOUR_MS && (only !== "closing" || row.closing));
  const freeAt = (list: { at: number }[], windowMs: number) =>
    minute(Math.min(...list.map((row) => row.at)) + windowMs);
  if (HIDING.includes(action)) {
    const hour = within(HOUR_MS, "closing");
    if (hour.length >= FACT_CLOSINGS_PER_HOUR)
      return refuse(
        "rate",
        `You have closed or redated ${hour.length} mail items in the last hour, which is the limit (${FACT_CLOSINGS_PER_HOUR} an hour). ${unchanged} Try again after ${freeAt(hour, HOUR_MS)}. Until then tell the owner which items are waiting and let them say which to close; a larger batch is theirs to approve.`
      );
    const day = within(DAY_MS, "closing");
    if (day.length >= FACT_CLOSINGS_PER_DAY)
      return refuse(
        "rate",
        `You have closed or redated ${day.length} mail items in the last day, which is the limit (${FACT_CLOSINGS_PER_DAY} a day). ${unchanged} Try again after ${freeAt(day, DAY_MS)}. Until then tell the owner which items are waiting and let them say which to close.`
      );
  }
  const writes = within(HOUR_MS);
  if (writes.length >= FACT_WRITES_PER_HOUR)
    return refuse(
      "rate",
      `You have marked ${writes.length} mail items in the last hour, which is the limit (${FACT_WRITES_PER_HOUR} an hour). ${unchanged} Try again after ${freeAt(writes, HOUR_MS)}.`
    );
  return null;
}

function parseDays(raw: unknown): number | null {
  if (raw === undefined) return FACT_HOLD_DEFAULT_DAYS;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,3}$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= FACT_HOLD_MAX_DAYS ? days : null;
}

function parseTime(raw: unknown): number | null {
  if (typeof raw !== "string" || !RFC3339.test(raw.trim())) return null;
  const parsed = Date.parse(raw.trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/** The latest status time the fold would see on this fact, clamped to when it was recorded as the fold does. */
function latestStatusMs(statuses: readonly FoldStatus[]): number {
  return statuses.reduce((latest, s) => {
    const said = ms(s.validFrom);
    const recorded = ms(s.ingestedAt);
    const effective = Number.isFinite(recorded) && Number.isFinite(said) && recorded < said ? recorded : said;
    return Number.isFinite(effective) ? Math.max(latest, effective) : latest;
  }, Number.NEGATIVE_INFINITY);
}

/** Which of an agent's marks on a fact still stand: its status wins the fold, or its time correction wins the `when`. */
function ownMarks(fold: FactFold, overrides: readonly FoldOverride[], by: string) {
  const status =
    fold.actor === "mark" &&
    fold.actorBy === by &&
    fold.status !== null &&
    fold.status !== "proposed" &&
    fold.status !== "expired" &&
    fold.status !== "source_gone";
  const win = winningOverride(overrides, "when");
  const when = win !== undefined && win.actor === "mark" && win.by === by;
  return { status, when };
}

export interface AgentMark {
  factId: string;
  factType: string;
  act: FactAct;
  /** When the agent wrote the mark that stands (RFC 3339). */
  at: string;
  /** Whether the fact is open now (a hold or a redate leaves it open; a done or an ignore closes it). */
  open: boolean;
}

const ACT_OF_STATUS: Readonly<Record<string, FactAct>> = { done: "done", cancelled: "ignore", confirmed: "confirm" };

/**
 * The marks this agent made that still stand, newest first: what `reopen` can take back. Not limited by age, so the one
 * place an agent can find the id of an old mark is complete.
 */
export function agentMarks(input: FoldInput, by: string): AgentMark[] {
  const marks: AgentMark[] = [];
  for (const fold of foldFactStates(input)) {
    if (fold.isLink) continue;
    const overrides = (input.overrides ?? []).filter((o) => o.factId === fold.factId);
    const own = ownMarks(fold, overrides, by);
    const candidates: AgentMark[] = [];
    if (own.status) {
      const rows = (input.statuses ?? []).filter(
        (s) => s.factId === fold.factId && s.actor === "mark" && s.by === by && s.status !== "proposed"
      );
      const latest = rows.reduce<FoldStatus | undefined>(
        (best, s) =>
          best === undefined || ms(s.ingestedAt ?? s.validFrom) >= ms(best.ingestedAt ?? best.validFrom) ? s : best,
        undefined
      );
      const act = (latest?.act as FactAct | null | undefined) ?? ACT_OF_STATUS[latest?.status ?? ""];
      if (latest !== undefined && act !== undefined)
        candidates.push({
          factId: fold.factId,
          factType: fold.factType,
          act,
          at: latest.ingestedAt ?? latest.validFrom,
          open: fold.open
        });
    }
    if (own.when) {
      const win = winningOverride(overrides, "when")!;
      candidates.push({ factId: fold.factId, factType: fold.factType, act: "redate", at: win.at, open: fold.open });
    }
    candidates.sort((a, b) => ms(b.at) - ms(a.at));
    if (candidates[0] !== undefined) marks.push(candidates[0]);
  }
  return marks.sort((a, b) => ms(b.at) - ms(a.at) || (a.factId < b.factId ? -1 : 1));
}

export function planFactAct(input: FactActInput): FactActPlan {
  const { action, factId, by, now } = input;
  const nowMs = now.getTime();
  if (!isAct(action))
    return refuse(
      "unknown_action",
      `"${cut(action)}" is not an action in room facts. Use one of: ${FACT_ACTS.join(", ")}. ${unchanged}`
    );
  if (by.trim() === "")
    return refuse(
      "no_agent",
      `This call carries no agent identity, so it cannot be recorded as anyone's mark. ${unchanged} Call it with an agent token; the owner's own changes are made in the portal.`
    );
  if (!FACT_ID.test(factId))
    return refuse(
      "bad_id",
      `"${cut(factId)}" is not a fact id: ids are 40 hex characters. Copy one exactly from ${LIST_CALL}. ${unchanged}`
    );
  const allowed = allowedKeys(action);
  for (const key of Object.keys(input.set))
    if (!allowed.includes(key))
      return refuse(
        "bad_params",
        `set accepts days (with confirm) and when, until (with redate); "${cut(key)}" is not one for ${action}. ${unchanged}`
      );

  const read: FoldInput = { ...input.fold, now };
  const fold = foldFactStates(read).find((f) => f.factId === factId);
  if (fold === undefined)
    return refuse(
      "not_found",
      `No open mail item has that id. Ids come from ${LIST_CALL}; copy one exactly (40 hex characters). ${unchanged}`
    );
  const label = labelOf(fold);
  const statuses = (read.statuses ?? []).filter((s) => s.factId === factId);
  const overrides = (read.overrides ?? []).filter((o) => o.factId === factId);
  const whenWin = winningOverride(overrides, "when");
  const rowOf = (read.facts as readonly FoldFactRow[]).find((r) => r.key === fold.rowKey);
  const askLike = fold.factType === "ask" || fold.factType === "commitment";

  if (fold.isLink)
    return refuse(
      "not_open",
      `The ${label} is no longer open (${whyNotOpen(fold)}). ${unchanged} List the open items again with ${LIST_CALL}.`
    );

  const decided = fold.actor === "person" && (fold.open || fold.closedBy === "status");
  if (decided && action !== "redate")
    return refuse(
      "owner_decided",
      `The owner already marked the ${label} ${fold.status ?? "decided"}${fold.closedAt ? ` at ${minute(fold.closedAt)}` : ""}, and their word stands, so nothing was changed. Leave it; do not try again.`
    );

  const basisOk = input.basis === "stated" && typeof input.evidence === "string" && input.evidence.trim() !== "";
  const stated = (): FactActPlan | null =>
    basisOk
      ? null
      : refuse(
          "needs_stated",
          `${action === "redate" ? "Changing an item's date" : "Closing a mail item"} needs the owner's own words. Repeat the call with basis "stated" and evidence set to what the owner said, in their words (up to ${FACT_EVIDENCE_MAX} characters). ${unchanged} If the owner has not said so, leave the item and say its ask once.`
        );
  const claim = (): Record<string, unknown> =>
    basisOk
      ? { basis: "stated", evidence: input.evidence!.trim().slice(0, FACT_EVIDENCE_MAX) }
      : input.basis !== undefined
        ? { basis: input.basis }
        : {};

  const vfMs = Math.max(nowMs, latestStatusMs(statuses) + 1);
  const validFrom = new Date(vfMs).toISOString();
  const rows: PlannedRow[] = [];
  const statusRow = (status: string, extra: Record<string, unknown> = {}): PlannedRow => ({
    kind: "fact_status",
    validFrom,
    attrs: { fact_id: factId, status, valid_from: validFrom, act: action, ...claim(), ...extra }
  });
  const overrideRow = (newValue: unknown): PlannedRow => ({
    kind: "override",
    validFrom,
    attrs: { fact_id: factId, field: "when", new_value: newValue, act: action, ...claim() }
  });

  let message: string;
  const undo = `Undo: ${reopenCall(factId)} (the owner can also undo it in Review > Agent changes).`;

  if (action === "confirm") {
    if (!askLike)
      return refuse(
        "wrong_type",
        `The ${label} is ${fold.factType === "event" ? "an event" : "a deadline"}, and it ends at its own date, so holding it open would only hide it. ${unchanged} If its date is wrong use redate (set ["when=2026-11-20T15:00:00+01:00"]); otherwise leave it.`
      );
    if (!fold.open) return notOpen(label, fold);
    const days = parseDays(input.set.days);
    if (days === null)
      return refuse(
        "bad_params",
        `days must be a whole number from 1 to ${FACT_HOLD_MAX_DAYS} (you sent "${cut(input.set.days)}"). Repeat with set ["days=${FACT_HOLD_DEFAULT_DAYS}"], for example. ${unchanged}`
      );
    const current = ms(fold.expiresAt);
    const wanted = nowMs + days * DAY_MS;
    if (Number.isFinite(current) && wanted <= current)
      return refuse(
        "no_effect",
        `The ${label} is already open until ${minute(current)}, which is longer than ${days} days from now, and a hold never shortens that. ${unchanged} Repeat with a larger days (up to ${FACT_HOLD_MAX_DAYS}) to hold it longer, or leave it.`
      );
    const end = Math.min(wanted, vfMs + STATUS_HOLD_MAX_DAYS * DAY_MS);
    rows.push(statusRow("confirmed", { expires_at: new Date(end).toISOString() }));
    message = `Held the ${label} open until ${minute(end)} (${days} days; it would otherwise have ended ${Number.isFinite(current) ? minute(current) : "sooner"}). This is your mark, not the owner's: the owner can overrule it, and it ends on that date. ${undo}`;
  } else if (action === "done" || action === "ignore") {
    const need = stated();
    if (need) return need;
    if (!fold.open) return notOpen(label, fold);
    rows.push(statusRow(action === "done" ? "done" : "cancelled"));
    message =
      `Marked the ${label} ${action === "done" ? "done" : "not wanted (closed)"}. It stays closed until this same ask comes up again in a later mail; a different new mail does not reopen it. ` +
      `If it is already saved on the plan as an action, that action is still open and was not changed. ${undo}`;
  } else if (action === "redate") {
    if (askLike)
      return refuse(
        "wrong_type",
        `The ${label} is ${fold.factType === "ask" ? "an ask" : "a commitment"}, which has no date to change; redate is for an event or a deadline. ${unchanged} To keep it open use confirm, to close it use done or ignore.`
      );
    if (whenWin?.actor === "person")
      return refuse(
        "owner_decided",
        `The owner already corrected the time of the ${label}, and their word stands, so nothing was changed. Leave it; do not try again.`
      );
    const ownMark = whenWin?.actor === "mark" && whenWin.by === by;
    if (!(fold.open || (fold.state === "expired" && ownMark))) return notOpen(label, fold);
    const need = stated();
    if (need) return need;
    const lower = ms(fold.tsStart);
    const upper = nowMs + RESCHEDULE_MAX_DAYS * DAY_MS;
    const start = parseTime(input.set.when);
    if (start === null || start < lower || start > upper)
      return refuse(
        "bad_params",
        `when must be an ISO time with the owner's UTC offset, such as 2026-11-20T15:00:00+01:00, between ${minute(lower)} and ${minute(upper)} (you sent "${cut(input.set.when)}"). ${unchanged}`
      );
    let newValue: Record<string, string> = { start: new Date(start).toISOString() };
    if (input.set.until !== undefined) {
      const end = parseTime(input.set.until);
      if (end === null || end < start || end > start + FACT_REDATE_SPAN_MAX_DAYS * DAY_MS)
        return refuse(
          "bad_params",
          `until must be an ISO time with the owner's UTC offset, at or after when and at most ${FACT_REDATE_SPAN_MAX_DAYS} days after it (you sent "${cut(input.set.until)}"). ${unchanged}`
        );
      newValue = { ...newValue, end: new Date(end).toISOString() };
    }
    rows.push(overrideRow(newValue));
    const earlier = fold.dueAt ? `the mail said ${minute(fold.dueAt)}` : "the mail gave no time";
    message =
      `Recorded that the ${label} is at ${minute(start)} (${earlier}). ` +
      (start < nowMs ? "That is already past, so it leaves the open list. " : "") +
      `The owner's own correction would win over this. ${undo}`;
  } else {
    // reopen: take back Mark's own mark.
    const { status: statusMine, when: whenMine } = ownMarks(fold, overrides, by);
    if (!statusMine && !whenMine)
      return refuse(
        "no_mark",
        `You have no mark on the ${label} to take back (${fold.open ? "it is open as the mail left it" : whyNotOpen(fold)}). ${unchanged} List the open items with ${LIST_CALL}.`
      );
    if (statusMine && fold.factType === "ask" && fold.direction !== "out") {
      const sinceMs = ms(fold.recentAt);
      const reply = (read.conversations?.[fold.conversationKey ?? ""] ?? [])
        .filter((m) => m.fromSelf && ms(m.at) > sinceMs)
        .reduce<number | null>((first, m) => (first === null || ms(m.at) < first ? ms(m.at) : first), null);
      if (reply !== null)
        return refuse(
          "answered",
          `The owner replied to the ${label} in the conversation at ${minute(reply)}, which closes an ask, so it cannot be reopened. ${unchanged} Leave it.`
        );
    }
    if (statusMine) rows.push(statusRow("proposed"));
    if (whenMine) rows.push(overrideRow(rowOf?.when ?? null));
    message = `Took back your mark on the ${label}; it is open again as the mail left it${whenMine ? ` (its time is back to ${fold.dueAt ? "what the mail said" : "none"})` : ""}.`;
  }

  const limited = rateRefusal(action, read, by, nowMs, input.history, factId);
  if (limited) return limited;

  // Run the plan through the fold: an action that changes nothing is refused, never reported as done.
  const after = foldFactStates({
    ...read,
    statuses: [
      ...(read.statuses ?? []),
      ...rows
        .filter((row) => row.kind === "fact_status")
        .map((row): FoldStatus => ({
          factId,
          status: row.attrs.status as FoldStatus["status"],
          validFrom: row.validFrom,
          actor: "mark",
          key: "planned",
          ingestedAt: row.validFrom,
          by,
          act: action,
          expiresAt: (row.attrs.expires_at as string | undefined) ?? null
        }))
    ],
    overrides: [
      ...(read.overrides ?? []),
      ...rows
        .filter((row) => row.kind === "override")
        .map((row): FoldOverride => ({
          factId,
          field: "when",
          newValue: row.attrs.new_value,
          at: row.validFrom,
          actor: "mark",
          key: "planned",
          by,
          act: action
        }))
    ]
  }).find((f) => f.factId === factId);
  const effect =
    after !== undefined &&
    (action === "done" || action === "ignore"
      ? after.state === "closed"
      : action === "redate"
        ? after.dueAt === (rows[0]!.attrs.new_value as { start: string }).start
        : action === "confirm"
          ? after.open && ms(after.expiresAt) > ms(fold.expiresAt)
          : after.open !== fold.open || after.dueAt !== fold.dueAt || after.status !== fold.status);
  if (!effect)
    return refuse(
      "no_effect",
      `That would not change the ${label}: something recorded later (the owner's word, a mail that moved it, or its own date) decides it. ${unchanged} List the open items with ${LIST_CALL} and leave this one.`
    );
  return { ok: true, act: action, factId, rows, message };
}

function notOpen(label: string, fold: FactFold): FactActPlan {
  return refuse(
    "not_open",
    `The ${label} is no longer open (${whyNotOpen(fold)}). Nothing was changed. List the open items again with ${LIST_CALL}.`
  );
}
