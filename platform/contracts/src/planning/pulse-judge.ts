/**
 * `pulse-criteria-and-publish`: the criteria for on plan / off plan / free / asleep, decided by the
 * user 2026-09-25/26. This closes
 * — `resolvePulse` (`pulse.ts`) names *what* the person is doing; `judgePulse` names whether that
 * counts as on plan. Pure: no zod, no I/O, no clock read except the `now` the caller passes.
 */

export type PulseTargetKind = "action" | "deliverable" | "commitment" | "step" | "sleep" | "journey";

export interface PulseTarget {
  kind: PulseTargetKind;
  id: string;
  title: string;
}

/** A directive kind that directs nothing — the plan has no target right now (Decision "Free time", Q1). */
const FREE_DIRECTIVE_KINDS = new Set(["none", "boundary", "answer", "recovery"]);

export interface JudgeDirective {
  kind: string;
  targetId?: string;
  title?: string;
}

export interface JudgeDayPlanBlock {
  kind: string;
  targetId: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
}

export type SessionSanction = "directive" | "alternative" | "day_plan_block" | "continuation" | "free" | null;

export interface JudgeSession {
  target: PulseTarget;
  sanction: SessionSanction;
  /** Null only for a `free` sanction or a legacy (pre-migration) NULL sanction judged live. */
  sanctionedUntil: Date | null;
  startedAt: Date;
}

export type CheckInStatus = "on_track" | "deviated" | "unknown";

export interface JudgeCheckIn {
  target: PulseTarget;
  slotAt: Date;
  status: CheckInStatus;
  answeredAt: Date | null;
}

export interface JudgeArrival {
  target: PulseTarget;
  at: Date;
}

export interface JudgeUnderway {
  target: PulseTarget;
  at: Date;
}

export interface JudgePulseInput {
  now: Date;
  directive: JudgeDirective | null;
  dayPlanBlocks: JudgeDayPlanBlock[];
  /** Commitments (timeline edges), routine steps, the sleep night — whichever are currently in force. */
  protectedInForce: PulseTarget[];
  session: JudgeSession | null;
  /** Every check-in slot since the day began. */
  checkIns: JudgeCheckIn[];
  arrival: JudgeArrival | null;
  underway: JudgeUnderway | null;
  /**
   * The sleep night in force right now, if any (Decision "Sleep"): `"sleeping"` for a plan whose
   * status is `sleeping`, or a completed night whose `actualStartAt`–`actualWakeAt` covers `now`
   * (both always read asleep, with no session caveat); `"planned"` for a planned night that has not
   * started sleeping yet (asleep only when the running session's own target is the sleep — see
   * `isAsleep`); `"awake"` when no sleep night covers `now` at all.
   */
  sleep: { state: "sleeping" | "planned" | "awake" };
  /** Effective privacy, already resolved (area → project → target, rule → occurrence), keyed `kind:id`. */
  privateTargets: ReadonlySet<string>;
}

export type PulseState = "on" | "off" | "free" | "asleep";
export type PulseReason = "confirmed" | "unconfirmed" | "deviated" | "unsanctioned" | "overran" | "free" | "asleep";

export interface PulseJudgement {
  state: PulseState;
  reason: PulseReason;
  doing?: PulseTarget;
  expected?: PulseTarget;
  confirmedAt?: Date;
  private: boolean;
}

function isPrivate(target: PulseTarget | undefined, privateTargets: ReadonlySet<string>): boolean {
  return target !== undefined && privateTargets.has(`${target.kind}:${target.id}`);
}

/** Whether the plan directs nothing right now — Decision "Free time" (Q1). */
function isFree(input: JudgePulseInput, now: Date): boolean {
  const directiveIsFree = !input.directive || FREE_DIRECTIVE_KINDS.has(input.directive.kind);
  const coveredByBlock = input.dayPlanBlocks.some(
    (block) =>
      block.kind !== "gap" &&
      block.kind !== "recovery" &&
      block.targetId !== null &&
      new Date(block.startsAt).getTime() <= now.getTime() &&
      now.getTime() < new Date(block.endsAt).getTime()
  );
  return directiveIsFree && !coveredByBlock && input.protectedInForce.length === 0;
}

/** What the plan sanctions right now, if anything — the directive's target, a covering block's
    target, or a protected block in force (Decision P1, "On plan"). */
function sanctionedTarget(input: JudgePulseInput, now: Date): PulseTarget | undefined {
  if (input.protectedInForce.length > 0) return input.protectedInForce[0];
  const block = input.dayPlanBlocks.find(
    (b) =>
      b.kind !== "gap" &&
      b.kind !== "recovery" &&
      b.targetId !== null &&
      new Date(b.startsAt).getTime() <= now.getTime() &&
      now.getTime() < new Date(b.endsAt).getTime()
  );
  if (!block) return directiveTarget(input);
  const directive = directiveTarget(input);
  // The stored directive is `blocks[0]`'s by construction (engine `day-plan.ts`'s own docstring), so
  // it agrees with the covering block only while `now` is still inside block 0's window. Once `now`
  // has moved into a later block without a fresh plan recalculation landing, or the covering block is
  // a protected commitment (whose directive kind is `none`, carrying no target of its own at all —
  // see `advance()`'s `case "none"` in `day-plan.ts`), the two can diverge; nothing in the engine
  // guarantees they agree beyond block 0. Prefer the directive's own resolved target (it already
  // carries a title) when it names the same thing the block covers, else resolve the block's own
  // target directly so a real divergence still yields an `expected`, not `undefined`.
  if (directive && directive.id === block.targetId && directive.kind === blockKindToTargetKind(block.kind)) {
    return directive;
  }
  return blockTarget(block);
}

function blockTarget(block: JudgeDayPlanBlock): PulseTarget | undefined {
  if (!block.targetId) return undefined;
  const kind = blockKindToTargetKind(block.kind);
  if (!kind) return undefined;
  return { kind, id: block.targetId, title: block.title };
}

function directiveTarget(input: JudgePulseInput): PulseTarget | undefined {
  const directive = input.directive;
  if (!directive || !directive.targetId) return undefined;
  const kind = directiveKindToTargetKind(directive.kind);
  if (!kind) return undefined;
  return { kind, id: directive.targetId, title: directive.title ?? "" };
}

function directiveKindToTargetKind(kind: string): PulseTargetKind | undefined {
  switch (kind) {
    case "action":
      return "action";
    case "deliverable":
      return "deliverable";
    case "routine_step":
      return "step";
    case "sleep":
      return "sleep";
    case "travel":
      return "journey";
    default:
      return undefined;
  }
}

/** Day-plan block kinds mirror directive kinds, plus `commitment` — a protected commitment's own
    directive kind is `none` (`day-plan.ts`'s `advance()`, `case "none"`), so it needs its own mapping
    here rather than reusing `directiveKindToTargetKind`. */
function blockKindToTargetKind(kind: string): PulseTargetKind | undefined {
  if (kind === "commitment") return "commitment";
  return directiveKindToTargetKind(kind);
}

function sameTarget(a: PulseTarget | undefined, b: PulseTarget | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** The latest check-in on a given target, if any. */
function latestCheckInFor(checkIns: JudgeCheckIn[], target: PulseTarget | undefined): JudgeCheckIn | undefined {
  if (!target) return undefined;
  return checkIns
    .filter((c) => sameTarget(c.target, target))
    .sort((a, b) => b.slotAt.getTime() - a.slotAt.getTime())[0];
}

/** Any holding confirmation of the given target: a check-in `on_track`, an arrival, or `underway` —
    sleep is judged up front by `isAsleep`, before this is ever consulted. */
function confirmationFor(input: JudgePulseInput, target: PulseTarget): { at: Date } | undefined {
  if (target.kind === "commitment" && input.arrival && sameTarget(input.arrival.target, target))
    return { at: input.arrival.at };
  if (target.kind === "journey" && input.underway && sameTarget(input.underway.target, target))
    return { at: input.underway.at };
  const checkIn = latestCheckInFor(input.checkIns, target);
  if (checkIn && checkIn.status === "on_track" && checkIn.answeredAt) return { at: checkIn.answeredAt };
  return undefined;
}

/** Whether the latest check-in on the target lapses it: answered `deviated`, or unanswered past the
    timeout window (the caller passes only check-ins whose timeout has already been evaluated, i.e.
    `status: "unknown"` once `CHECK_IN_TIMEOUT_MINUTES` has elapsed). */
function lapsed(input: JudgePulseInput, target: PulseTarget | undefined): JudgeCheckIn | undefined {
  const checkIn = latestCheckInFor(input.checkIns, target);
  if (checkIn && (checkIn.status === "deviated" || checkIn.status === "unknown")) return checkIn;
  return undefined;
}

/**
 * Whether the night reads asleep right now (Decision "Sleep"). A plan that is actually `sleeping`, or
 * a completed night still spanning `now`, is asleep no matter what else is running — starting sleep
 * both flips the plan to `sleeping` and opens a `sleep`-target session, and neither a stale directive
 * nor that very session should turn the night back into "on plan". Only a night that is merely
 * `planned` (bedtime passed, sleep not started) is not asleep: nothing says he went to bed, so it reads
 * asleep only when the running session's own target is the sleep. Otherwise he is judged by what he is
 * doing, and the quiet-night window holds him as scheduled, not lapsed.
 */
function isAsleep(input: JudgePulseInput): boolean {
  switch (input.sleep.state) {
    case "sleeping":
      return true;
    case "planned":
      return input.session?.target.kind === "sleep";
    case "awake":
      return false;
  }
}

/**
 * The order (design note, "The judge"): asleep → a running session (frozen sanction) → a lapse on
 * the expected target → any other holding confirmation of a sanctioned target → nothing sanctioned
 * (free) → off/unconfirmed.
 */
export function judgePulse(input: JudgePulseInput): PulseJudgement {
  const now = input.now;

  if (isAsleep(input)) {
    return { state: "asleep", reason: "asleep", private: false };
  }

  if (input.session) {
    const session = input.session;
    const target = session.target;
    const priv = isPrivate(target, input.privateTargets);
    if (session.sanction === "free") {
      return { state: "free", reason: "free", doing: target, private: priv };
    }
    if (session.sanction === null) {
      // Legacy (pre-migration) session: judged live against what the plan currently sanctions.
      const sanctioned = sanctionedTarget(input, now);
      if (sameTarget(sanctioned, target)) {
        return { state: "on", reason: "confirmed", doing: target, confirmedAt: session.startedAt, private: priv };
      }
      return { state: "off", reason: "unsanctioned", doing: target, private: priv };
    }
    // directive / alternative / day_plan_block / continuation: sanctioned while its clock holds.
    if (session.sanctionedUntil && now.getTime() >= session.sanctionedUntil.getTime()) {
      return { state: "off", reason: "overran", doing: target, private: priv };
    }
    return { state: "on", reason: "confirmed", doing: target, confirmedAt: session.startedAt, private: priv };
  }

  const expected = sanctionedTarget(input, now);

  if (expected) {
    const lapse = lapsed(input, expected);
    if (lapse) {
      const priv = isPrivate(expected, input.privateTargets);
      return {
        state: "off",
        reason: lapse.status === "deviated" ? "deviated" : "unconfirmed",
        expected,
        private: priv
      };
    }
    const confirmation = confirmationFor(input, expected);
    if (confirmation) {
      const priv = isPrivate(expected, input.privateTargets);
      return { state: "on", reason: "confirmed", doing: expected, confirmedAt: confirmation.at, private: priv };
    }
    const priv = isPrivate(expected, input.privateTargets);
    return { state: "off", reason: "unconfirmed", expected, private: priv };
  }

  if (isFree(input, now)) {
    return { state: "free", reason: "free", private: false };
  }

  return { state: "off", reason: "unconfirmed", private: false };
}
