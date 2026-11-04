import type { PulseJudgement } from "./pulse-judge.js";

/**
 * The pulse state machine: contact (do we know what the person is
 * doing?) layered over the memoryless adherence judgement (`judgePulse`: is it the plan?). The judge
 * has no memory and turns one unanswered check-in straight into `off/unconfirmed`; this module adds
 * the memory, an `unknown` state between `on` and `off/lapsed`, disruptions, expected silence (a work
 * shift, the sleep night), and the size of the catch-up a return needs. Pure: no zod, no I/O, no clock
 * read except the `now` the caller passes.
 */

/**
 * The three lapse numbers are settings (design note, section 2), not constants; these are the defaults,
 * beside `CHECK_IN_TIMEOUT_MINUTES` in spirit (that one lives in
 * `platform/database/src/planning/check-in-scheduler.ts`, which contracts cannot import).
 * `unknownToOffMinutes` with `furtherPrompts` unanswered prompts since the unknown began is the owner's
 * "two missed check-ins in a row" at base cadence; `unknownHardOffMinutes` is the cap when no further
 * prompt goes out (the scheduler skipped, a push failed, or the hourly cadence).
 */
export interface PulseThresholds {
  unknownToOffMinutes: number;
  furtherPrompts: number;
  unknownHardOffMinutes: number;
}
export const DEFAULT_PULSE_THRESHOLDS: PulseThresholds = {
  unknownToOffMinutes: 30,
  furtherPrompts: 1,
  unknownHardOffMinutes: 60
};
/** Default `checkInExtraMinutes` of a commitment: while it is in force both minute thresholds grow by it. */
export const DEFAULT_CHECK_IN_EXTRA_MINUTES = 15;
/** Minutes after an expected-silence window ends with no contact before the state is `off/lapsed`
    (sleep: before it is `unknown`). */
export const SILENCE_GRACE_MINUTES = 60;
/** Slack past the grace in which an ended window is still returned, so a late tick still sees it. */
export const SILENCE_LOOKBACK_SLACK_MINUTES = 60;
/** Defaults for the fresh-contact window: a check-in cadence of 20 minutes (base; hourly is 60) plus the
    10 minute `CHECK_IN_TIMEOUT_MINUTES` (which lives in `platform/database`). */
export const DEFAULT_CHECK_IN_CADENCE_MINUTES = 20;
export const DEFAULT_CHECK_IN_TIMEOUT_MINUTES = 10;
/** Gap since last confirmed from which a re-entry reviews today's planned things item by item (2 h). */
export const REENTRY_TODAY_AFTER_MINUTES = 2 * 60;
/** Gap from which a re-entry groups by day (36 h, the existing catch-up due threshold). */
export const REENTRY_DAYS_AFTER_MINUTES = 36 * 60;
/** Gap from which a re-entry groups by project and offers a soft reset (7 days). */
export const REENTRY_PROJECTS_AFTER_MINUTES = 7 * 24 * 60;

/**
 * The extra minutes for the commitment in force: its own `checkInExtraMinutes` (any custom value,
 * including 0), else the default. No commitment in force: 0.
 */
export function resolveCheckInExtraMinutes(
  commitment: { checkInExtraMinutes?: number | null } | null | undefined
): number {
  if (!commitment) return 0;
  const own = commitment.checkInExtraMinutes;
  return typeof own === "number" && Number.isFinite(own) && own >= 0 ? own : DEFAULT_CHECK_IN_EXTRA_MINUTES;
}

export type PulseMachineState = "on" | "unknown" | "off" | "free" | "asleep";
/** Why the state is `off`. Only `lapsed` exists: contact was lost, or he deviated without telling the
    system enough to use. It needs re-entry. */
export type PulseOffReason = "lapsed";
/** Why the state is `on`. `scheduled` is confirmation by schedule, weaker than an answer; `disrupted`
    is a deviation recorded with a usable disruption. */
export type PulseOnReason = "confirmed" | "scheduled" | "reentered" | "disrupted";
export type ContactSource = "person" | "agent" | "schedule";

/** A person or agent write of a state fact (check-in answer, session start/finish, wake, location,
    energy, catch-up settle, photo check-in, arrival). Agent plan edits are not contact. */
export interface ContactEvent {
  at: Date;
  source: ContactSource;
}

/**
 * A deviation counts as on plan only when it carries all of these (design note, section 1). Fields are
 * optional so a caller can pass what it has and `missingDisruptionFields` can name what is absent.
 */
export interface Disruption {
  /** What he is doing instead. */
  doing?: string | null;
  /** Roughly until when. */
  until?: Date | null;
  locationId?: string | null;
  /** The contexts available to him (at least one). */
  contexts?: readonly string[] | null;
  /** Whether the commitment takes all of him (true) or he could still do other things (false). */
  exclusive?: boolean | null;
}
export type DisruptionField = "doing" | "until" | "locationId" | "contexts" | "exclusive";
export type UsableDisruption = Required<{ [K in keyof Disruption]: NonNullable<Disruption[K]> }>;

/** The names of the fields a disruption lacks; empty means it is usable. */
export function missingDisruptionFields(disruption: Disruption | null | undefined): DisruptionField[] {
  const d = disruption ?? {};
  const missing: DisruptionField[] = [];
  if (typeof d.doing !== "string" || d.doing.trim() === "") missing.push("doing");
  if (!(d.until instanceof Date) || Number.isNaN(d.until.getTime())) missing.push("until");
  if (typeof d.locationId !== "string" || d.locationId.trim() === "") missing.push("locationId");
  if (!Array.isArray(d.contexts) || d.contexts.length === 0) missing.push("contexts");
  if (typeof d.exclusive !== "boolean") missing.push("exclusive");
  return missing;
}

export type ExpectedSilenceKind = "shift" | "sleep";

/** A window in which no contact can be expected. */
export interface ExpectedSilenceWindow {
  startsAt: Date;
  endsAt: Date;
  kind: ExpectedSilenceKind;
}

export interface SilentCommitment {
  startsAt: Date;
  endsAt: Date;
  /** The commitment's `promptPolicy`; only `silent` opens a window (`reduced` and `normal` do not). */
  promptPolicy: string | null | undefined;
}

export interface ResolveExpectedSilenceInput {
  commitments: readonly SilentCommitment[];
  /** The sleep night: planned start to planned wake (or actual start to actual wake when known). */
  sleepNight: { startsAt: Date; endsAt: Date } | null;
  now: Date;
  /** The commitment allowance in force (`resolveCheckInExtraMinutes`); widens the lookback. Default 0. */
  extraMinutes?: number;
}

/**
 * The window containing `now`, else the most recent window that ended at or before `now`, else null.
 * Several overlapping windows containing `now`: the one ending last. A window not yet started is never
 * returned. A caller wanting only the active window checks `startsAt <= now < endsAt`. A shift that
 * runs over is extended by editing its commitment, so the caller's windows already carry the extension.
 */
export function resolveExpectedSilence(input: ResolveExpectedSilenceInput): ExpectedSilenceWindow | null {
  const now = input.now.getTime();
  const windows: ExpectedSilenceWindow[] = [];
  for (const commitment of input.commitments) {
    if (commitment.promptPolicy === "silent" && commitment.endsAt.getTime() > commitment.startsAt.getTime()) {
      windows.push({ startsAt: commitment.startsAt, endsAt: commitment.endsAt, kind: "shift" });
    }
  }
  if (input.sleepNight && input.sleepNight.endsAt.getTime() > input.sleepNight.startsAt.getTime()) {
    windows.push({ startsAt: input.sleepNight.startsAt, endsAt: input.sleepNight.endsAt, kind: "sleep" });
  }
  const containing = windows
    .filter((w) => w.startsAt.getTime() <= now && now < w.endsAt.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
  if (containing[0]) return containing[0];
  const lookbackMs =
    (SILENCE_GRACE_MINUTES + SILENCE_LOOKBACK_SLACK_MINUTES + Math.max(0, input.extraMinutes ?? 0)) * 60_000;
  const ended = windows
    .filter((w) => w.endsAt.getTime() <= now && now - w.endsAt.getTime() <= lookbackMs)
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
  return ended[0] ?? null;
}

/** The machine's memory between ticks. Regenerable; the recorder persists it. */
export interface PulseMachineMemory {
  state: PulseMachineState;
  /** Set only while `state` is `off`. */
  offReason: PulseOffReason | null;
  /** Set only while `state` is `on`. */
  onReason: PulseOnReason | null;
  /** When the current state began. */
  since: Date;
  /** The last real confirmation (never moved by a schedule hold). */
  lastConfirmedAt: Date | null;
  /** Who made the confirmation that `lastConfirmedAt` records. */
  confirmedBy: "person" | "agent" | null;
  /** The latest person/agent contact seen (any kind, confirming or not, in a window or not). */
  lastContact: ContactEvent | null;
  /** When the current `unknown` began; null otherwise. */
  unknownSince: Date | null;
  /** Unfrozen minutes spent unknown (silence windows do not count). */
  unknownMinutes: number;
  /** The usable disruption holding `on/disrupted`; null otherwise. */
  disruption: UsableDisruption | null;
  /** The `now` of the previous advance. */
  advancedAt: Date;
}

export interface PulseEvidence {
  /** The latest person or agent contact; `schedule` never moves `lastConfirmedAt`. Voluntary contact
      inside a silence window counts too, and is never required. */
  contact: ContactEvent | null;
  /** A `reenter` command applied since the previous advance. Only acts on `off/lapsed`. */
  reentered: ContactEvent | null;
  /** A deviation's disruption detail, consulted when the judge says `off/deviated|unsanctioned`.
      Absent or incomplete means `off/lapsed` straight away. */
  disruption?: Disruption | null;
  /** When each check-in prompt went out (any state), so prompts since `unknownSince` can be counted. */
  promptsSentAt: readonly Date[];
  /** An unanswered prompt for the current target is past its timeout. Without it (or `sessionStale`), an
      `on` state is not degraded merely because no confirmation exists yet. */
  promptTimedOut?: boolean;
  /** The running session passed its freshness limit (planned end + max(60 min, planned length)). */
  sessionStale?: boolean;
  /** The current check-in cadence in minutes: 20 base, 60 hourly. Default 20. */
  cadenceMinutes?: number;
  /** The check-in timeout in minutes. Default 10. */
  checkInTimeoutMinutes?: number;
  /** When the current block or session started; a fresh start holds `on` until a prompt can be missed. */
  blockStartedAt?: Date | null;
}

export interface PulseMachineConfig {
  /** The user's settings; defaults fill anything missing. */
  thresholds?: Partial<PulseThresholds>;
  /** Minutes added to both minute thresholds while a commitment is in force (`resolveCheckInExtraMinutes`). */
  extraMinutes?: number;
}

export interface PulseMachineResult extends PulseMachineMemory {
  /** End of the silence window holding the state, else null. */
  silenceUntil: Date | null;
  /** True only on the advance that moved the state into `off/lapsed` (the one "Back on plan?" push). */
  enteredLapsed: boolean;
}

const MS_PER_MINUTE = 60_000;

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

function overlapMinutes(from: Date, to: Date, window: ExpectedSilenceWindow | null): number {
  if (!window) return 0;
  const start = Math.max(from.getTime(), window.startsAt.getTime());
  const end = Math.min(to.getTime(), window.endsAt.getTime());
  return Math.max(0, (end - start) / MS_PER_MINUTE);
}

function newerContact(a: ContactEvent | null, b: ContactEvent | null): ContactEvent | null {
  if (!a) return b;
  if (!b) return a;
  return b.at.getTime() > a.at.getTime() ? b : a;
}

function freshMemory(now: Date): PulseMachineMemory {
  return {
    state: "free",
    offReason: null,
    onReason: null,
    since: now,
    lastConfirmedAt: null,
    confirmedBy: null,
    lastContact: null,
    unknownSince: null,
    unknownMinutes: 0,
    disruption: null,
    advancedAt: now
  };
}

/**
 * Advance the machine one tick (design note, sections 1 to 3).
 *
 * - The judge saying `on`, `free` or `asleep` sets that state and clears any unknown or disruption.
 * - The judge saying `off` for `deviated` or `unsanctioned` is `on/disrupted` when
 *   `evidence.disruption` is complete (`missingDisruptionFields`), else `off/lapsed` straight away.
 *   A disruption holds while the judge keeps saying `off` and `now` is before its `until`; after that
 *   the confirmation has lapsed and the usual `unknown` path begins.
 * - The judge saying `off/unconfirmed` is only a candidate for `unknown`. `unknown` becomes `off/lapsed`
 *   after `unknownToOffMinutes` with `furtherPrompts` unanswered prompts sent since the unknown began, or
 *   after `unknownHardOffMinutes` regardless; both minute figures grow by `config.extraMinutes`.
 * - Inside a silence window the clocks freeze (`unknownMinutes` does not grow, `lastConfirmedAt` does
 *   not move) and an unconfirmed state holds `on/scheduled`; an already `unknown` state stays unknown.
 * - After a shift window ends, `on/scheduled` holds until `SILENCE_GRACE_MINUTES` after the end; with no
 *   contact since the end by then it is a hard `off/lapsed` with no unknown phase. A contact since the
 *   end satisfies it and the usual unknown path takes over. The judge saying `asleep` is
 *   always `asleep`; no post-window lapse applies. `resolveExpectedSilence` only returns an ended window
 *   within the grace plus slack, so an old window never reaches this function.
 * - `off/lapsed` is never healed by the judge, a contact, a disruption or a silence window; only
 *   `evidence.reentered`.
 */
export function advancePulse(
  prev: PulseMachineMemory | null,
  judgement: PulseJudgement,
  evidence: PulseEvidence,
  silence: ExpectedSilenceWindow | null,
  now: Date,
  config: PulseMachineConfig = {}
): PulseMachineResult {
  const thresholds = { ...DEFAULT_PULSE_THRESHOLDS, ...config.thresholds };
  const extra = Math.max(0, config.extraMinutes ?? 0);
  const base = prev ?? freshMemory(now);
  const lastContact = newerContact(newerContact(base.lastContact, evidence.contact), evidence.reentered);
  const nowMs = now.getTime();
  const inWindow = !!silence && silence.startsAt.getTime() <= nowMs && nowMs < silence.endsAt.getTime();
  const silenceUntil = inWindow && silence ? silence.endsAt : null;
  const awakeMinutes = Math.max(
    0,
    minutesBetween(base.advancedAt, now) - overlapMinutes(base.advancedAt, now, silence)
  );

  const settle = (
    next: Partial<PulseMachineMemory> & Pick<PulseMachineMemory, "state">,
    enteredLapsed = false
  ): PulseMachineResult => {
    const changed =
      next.state !== base.state ||
      (next.offReason ?? null) !== base.offReason ||
      (next.onReason ?? null) !== base.onReason;
    return {
      offReason: null,
      onReason: null,
      lastConfirmedAt: base.lastConfirmedAt,
      confirmedBy: base.confirmedBy,
      unknownSince: null,
      unknownMinutes: 0,
      disruption: null,
      ...next,
      since: changed ? now : base.since,
      lastContact,
      advancedAt: now,
      silenceUntil,
      enteredLapsed
    };
  };

  // Minutes from `from` to now outside the silence window, as the main path counts them.
  const awakeSince = (from: Date): number =>
    Math.max(0, minutesBetween(from, now) - overlapMinutes(from, now, silence));

  const lapse = () => settle({ state: "off", offReason: "lapsed" }, true);

  // Lapsed: only an explicit re-entry heals it.
  if (base.state === "off" && base.offReason === "lapsed") {
    if (evidence.reentered) {
      return settle({
        state: "on",
        onReason: "reentered",
        lastConfirmedAt: evidence.reentered.at,
        confirmedBy: evidence.reentered.source === "agent" ? "agent" : "person"
      });
    }
    return settle({ state: "off", offReason: "lapsed" });
  }

  const confirm = (): Pick<PulseMachineMemory, "lastConfirmedAt" | "confirmedBy"> => {
    const at = judgement.confirmedAt ?? evidence.contact?.at ?? now;
    if (base.lastConfirmedAt && base.lastConfirmedAt.getTime() > at.getTime()) {
      return { lastConfirmedAt: base.lastConfirmedAt, confirmedBy: base.confirmedBy };
    }
    const source = lastContact && lastContact.source !== "schedule" ? lastContact.source : null;
    return { lastConfirmedAt: at, confirmedBy: source ?? "person" };
  };

  // Continue or start an unknown that began at `startedAt`, then apply the lapse thresholds.
  const unknownFrom = (startedAt: Date, minutes: number): PulseMachineResult => {
    const further = evidence.promptsSentAt.filter((at) => at.getTime() > startedAt.getTime()).length;
    if (
      minutes >= thresholds.unknownHardOffMinutes + extra ||
      (minutes >= thresholds.unknownToOffMinutes + extra && further >= thresholds.furtherPrompts)
    ) {
      return lapse();
    }
    return settle({ state: "unknown", unknownSince: startedAt, unknownMinutes: minutes });
  };

  const windowEnded = !!silence && silence.endsAt.getTime() <= nowMs;
  const graceEndsAt = silence ? silence.endsAt.getTime() + SILENCE_GRACE_MINUTES * MS_PER_MINUTE : 0;
  const contactSinceEnd =
    !!silence &&
    !!lastContact &&
    lastContact.source !== "schedule" &&
    lastContact.at.getTime() >= silence.endsAt.getTime();

  switch (judgement.state) {
    case "free":
      return settle({ state: "free" });
    case "on":
      return settle({ state: "on", onReason: "confirmed", ...confirm() });
    case "asleep":
      // No post-window lapse applies: a stale wake is asked about by the freshness need, and a window
      // that ended hours ago says nothing about a night that has not started.
      return settle({ state: "asleep" });
    case "off":
      break;
  }

  if (judgement.reason === "overran") {
    // A running session past its sanction is still the session he started: it holds `on` until its
    // freshness limit (`sessionStale`), then the confirmation has lapsed and the unknown path runs.
    if (base.state === "unknown" && base.unknownSince) {
      return unknownFrom(base.unknownSince, base.unknownMinutes + awakeMinutes);
    }
    if (evidence.sessionStale !== true) {
      return settle({
        state: "on",
        onReason: base.state === "on" ? (base.onReason ?? "confirmed") : "confirmed",
        disruption: base.state === "on" ? base.disruption : null
      });
    }
    return settle({ state: "unknown", unknownSince: now, unknownMinutes: 0 });
  }

  if (judgement.reason === "deviated" || judgement.reason === "unsanctioned") {
    const given = evidence.disruption;
    if (given && missingDisruptionFields(given).length === 0 && (given.until as Date).getTime() > nowMs) {
      return settle({ state: "on", onReason: "disrupted", disruption: given as UsableDisruption });
    }
    if (base.state === "on" && base.onReason === "disrupted" && base.disruption) {
      if (base.disruption.until.getTime() > nowMs) {
        return settle({ state: "on", onReason: "disrupted", disruption: base.disruption });
      }
      return unknownFrom(base.disruption.until, awakeSince(base.disruption.until));
    }
    // The unknown that began when a recorded disruption ran out carries on while the judge still says the same
    // deviation; it is not a fresh deviation with no detail.
    if (
      base.state === "unknown" &&
      base.unknownSince &&
      given?.until instanceof Date &&
      given.until.getTime() === base.unknownSince.getTime()
    ) {
      return unknownFrom(base.unknownSince, base.unknownMinutes + awakeMinutes);
    }
    return lapse();
  }

  // off/unconfirmed: only a candidate for unknown, unless a complete disruption is in force. Recording what he is
  // doing, until when, where, with which contexts and whether it takes all of him is what keeps him on plan, whatever
  // the judge could not confirm (nothing running, no directive target, a missed prompt, a stale session). Asleep and
  // free never reach here, and a lapse was settled above: only re-entry heals it.
  const inForce = evidence.disruption;
  if (inForce && missingDisruptionFields(inForce).length === 0 && (inForce.until as Date).getTime() > nowMs) {
    return settle({ state: "on", onReason: "disrupted", disruption: inForce as UsableDisruption });
  }
  if (base.state === "on" && base.onReason === "disrupted" && base.disruption) {
    if (base.disruption.until.getTime() > nowMs) {
      return settle({ state: "on", onReason: "disrupted", disruption: base.disruption });
    }
    return unknownFrom(base.disruption.until, awakeSince(base.disruption.until));
  }
  if (inWindow) {
    if (base.state === "unknown" && base.unknownSince) {
      // Frozen: only the part of this interval before the window started still counts.
      return settle({
        state: "unknown",
        unknownSince: base.unknownSince,
        unknownMinutes: base.unknownMinutes + awakeMinutes
      });
    }
    return settle({ state: "on", onReason: "scheduled" });
  }
  if (base.state === "unknown" && base.unknownSince) {
    return unknownFrom(base.unknownSince, base.unknownMinutes + awakeMinutes);
  }
  if (windowEnded && base.state === "on" && base.onReason === "scheduled") {
    if (nowMs < graceEndsAt) return settle({ state: "on", onReason: "scheduled" });
    if (!contactSinceEnd) return lapse();
  }
  // No confirmation yet is not a missed one. Fresh contact (a re-entry, an answer, a just-started
  // block) holds `on`; unknown starts only from a missed prompt, a stale session, or contact older than
  // the cadence plus the timeout (both lengthened by the commitment allowance).
  const missed = evidence.promptTimedOut === true || evidence.sessionStale === true;
  const freshWindowMs =
    ((evidence.cadenceMinutes ?? DEFAULT_CHECK_IN_CADENCE_MINUTES) +
      (evidence.checkInTimeoutMinutes ?? DEFAULT_CHECK_IN_TIMEOUT_MINUTES) +
      extra) *
    MS_PER_MINUTE;
  const anchors = [
    lastContact && lastContact.source !== "schedule" ? lastContact.at.getTime() : null,
    base.lastConfirmedAt?.getTime() ?? null,
    evidence.blockStartedAt?.getTime() ?? null
  ].filter((v): v is number => v !== null);
  const fresh = anchors.length > 0 && nowMs - Math.max(...anchors) < freshWindowMs;
  if (!missed && fresh) {
    return settle({ state: "on", onReason: base.state === "on" ? (base.onReason ?? "confirmed") : "confirmed" });
  }
  return settle({ state: "unknown", unknownSince: now, unknownMinutes: 0 });
}

export type ReentryTier = "none" | "today" | "days" | "projects";

/** How much a return reviews, from the minutes since last confirmed (design note, section 4). */
export function reentryTier(gapMinutes: number): ReentryTier {
  if (gapMinutes >= REENTRY_PROJECTS_AFTER_MINUTES) return "projects";
  if (gapMinutes >= REENTRY_DAYS_AFTER_MINUTES) return "days";
  if (gapMinutes >= REENTRY_TODAY_AFTER_MINUTES) return "today";
  return "none";
}
