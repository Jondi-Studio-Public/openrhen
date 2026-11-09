/**
 * The baseline drift rules, run in shadow: pure functions over a moment and the signals around it. Nothing here sends
 * anything or reads pulse state; a rule only says "flag this moment". The flags are scored by `drift-eval.ts` against
 * the episodes of `drift-episodes.ts`. Like those, it is not re-exported from the contracts barrel and the planner
 * never reads it (`drift-boundary.test.ts`). See docs/architecture/drift.md.
 */
import type { DriftType } from "./drift-episodes.js";

/** Every threshold, frozen in one place. A tuned value replaces one of these in a reviewed change, never at run time. */
export const DRIFT_RULE_THRESHOLDS = Object.freeze({
  /** Rule B: a moment within this many minutes after a shift ends is flagged. */
  afterShiftMinutes: 30,
  /** A flag is not eligible within this many minutes of a switch (the first minutes after one are unscored). */
  postSwitchExclusionMinutes: 5,
  /** The same rule does not flag again within this many minutes. */
  cooldownMinutes: 15,
  /** A flag bucket: one flag per user and rule per bucket, so a repeated tick writes the same key. */
  bucketMinutes: 5
});

export const DRIFT_RULE_IDS = ["work_item_diversion", "after_shift"] as const;
export type DriftRuleId = (typeof DRIFT_RULE_IDS)[number];

/** A drift type the first rules cannot be scored on is still named here, so its signals take part in the disjointness check. */
export type LabelType = DriftType | "activity_mismatch";

/** Signals as data: the raw inputs each drift type's definition reads, and each rule's features. */
export const DRIFT_SIGNAL_NAMES = [
  "checkin_deviated",
  "session_started",
  "session_ended",
  "plan_sanction",
  "foreground_category",
  "suppressed_interval",
  "work_item",
  "shift_end_activity"
] as const;
export type DriftSignalName = (typeof DRIFT_SIGNAL_NAMES)[number];

export const labelSignals: Readonly<Record<LabelType, readonly DriftSignalName[]>> = Object.freeze({
  deviated_checkin: ["checkin_deviated"],
  unsanctioned_session: ["session_started", "session_ended", "plan_sanction"],
  activity_mismatch: ["foreground_category", "suppressed_interval", "work_item"]
});

export const ruleSignals: Readonly<Record<DriftRuleId, readonly DriftSignalName[]>> = Object.freeze({
  work_item_diversion: ["foreground_category", "suppressed_interval", "work_item"],
  after_shift: ["shift_end_activity"]
});

/** The drift types a rule may be scored on: those whose definition shares none of the rule's own signals. */
export function scorableTypes(rule: DriftRuleId): LabelType[] {
  const own = new Set<string>(ruleSignals[rule]);
  return (Object.keys(labelSignals) as LabelType[]).filter((type) => labelSignals[type].every((s) => !own.has(s)));
}

/** Normalised foreground categories that count as a game or media diversion (lower-case, singular). */
export const DIVERSION_CATEGORIES: readonly string[] = Object.freeze(["game", "media"]);

/** Lower-case, trim, fold a plural to its singular (`games` to `game`). Empty input gives the empty string. */
export function normaliseCategory(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const lower = raw.trim().toLowerCase();
  return lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss") ? lower.slice(0, -1) : lower;
}

/** What is in front of the person at the moment. A hidden game interval carries a reason and no name. */
export interface ForegroundSignal {
  category?: string | null;
  /** True for a `suppressed` interval whose reason is the denylist. */
  suppressedDenylist?: boolean;
}

/** One evaluation moment. `pulse` is only the state label; no timers of the state machine are inputs. */
export interface DriftMoment {
  /** Stable for the moment, e.g. the user and the tick bucket. */
  id: string;
  at: Date;
  /** The pulse state label; only `on` is eligible. */
  pulse: string;
  /** From heartbeat or coverage rows, not from row absence. */
  captureLive: boolean;
  /** The last item or app switch before the moment, if any. */
  lastSwitchAt: Date | null;
  foreground: ForegroundSignal | null;
  /** The planned item now in front, opaque to the rules. */
  item: unknown;
  /** The previous flag time per rule, for the cooldown. */
  lastFlagAt: Partial<Record<DriftRuleId, Date>>;
}

const MINUTE = 60_000;

/** The moments a rule may flag at: pulse on, capture live, clear of a switch. The cooldown is per rule. */
export function isFlagEligible(moment: DriftMoment): boolean {
  if (moment.pulse !== "on" || !moment.captureLive) return false;
  if (!moment.lastSwitchAt) return true;
  const elapsed = moment.at.getTime() - moment.lastSwitchAt.getTime();
  return elapsed >= DRIFT_RULE_THRESHOLDS.postSwitchExclusionMinutes * MINUTE || elapsed < 0;
}

function cooledDown(moment: DriftMoment, rule: DriftRuleId): boolean {
  const last = moment.lastFlagAt[rule];
  return !last || moment.at.getTime() - last.getTime() >= DRIFT_RULE_THRESHOLDS.cooldownMinutes * MINUTE;
}

/** Rule A, behind an injected predicate until a work-item marker exists: a hidden or game/media foreground during a work item. */
export function workItemDiversionApplies(moment: DriftMoment, isWorkItem: (item: unknown) => boolean): boolean {
  const fg = moment.foreground;
  if (!fg || !isWorkItem(moment.item)) return false;
  return fg.suppressedDenylist === true || DIVERSION_CATEGORIES.includes(normaliseCategory(fg.category));
}

/** Rule B: within the first 30 minutes after a shift ended, the end measured from activity by the caller. */
export function afterShiftApplies(moment: DriftMoment, shiftEnds: readonly Date[]): boolean {
  const t = moment.at.getTime();
  const reach = DRIFT_RULE_THRESHOLDS.afterShiftMinutes * MINUTE;
  return shiftEnds.some((end) => t >= end.getTime() && t - end.getTime() < reach);
}

export interface RuleContext {
  /** Shift ends measured from activity, never from the pulse shift-grace lapse. */
  shiftEnds: readonly Date[];
  /** Absent until a work-item marker exists: rule A then never fires. */
  isWorkItem?: (item: unknown) => boolean;
}

export interface RuleFlag {
  rule: DriftRuleId;
  momentId: string;
  at: Date;
  /** Always `shadow`: nothing is sent. */
  arm: "shadow";
  /** The deterministic 20% assignment, recorded for later; it never subsets the shadow score. */
  holdout: boolean;
  bucket: number;
}

export const DRIFT_HOLDOUT_PERCENT = 20;

/** FNV-1a over the moment id, so the same moment always gets the same assignment. */
export function holdoutAssigned(momentId: string): boolean {
  let hash = 0x811c9dc5;
  for (let i = 0; i < momentId.length; i += 1) {
    hash ^= momentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100 < DRIFT_HOLDOUT_PERCENT;
}

export function flagBucket(at: Date): number {
  return Math.floor(at.getTime() / (DRIFT_RULE_THRESHOLDS.bucketMinutes * MINUTE));
}

/** The idempotent key of a flag row: `user|rule|bucket`. */
export function flagEventKey(userId: string, rule: DriftRuleId, bucket: number): string {
  return `${userId}|${rule}|${bucket}`;
}

/** Evaluate every rule at one moment. */
export function evaluateRules(moment: DriftMoment, context: RuleContext): RuleFlag[] {
  if (!isFlagEligible(moment)) return [];
  const hits: DriftRuleId[] = [];
  if (context.isWorkItem && workItemDiversionApplies(moment, context.isWorkItem)) hits.push("work_item_diversion");
  if (afterShiftApplies(moment, context.shiftEnds)) hits.push("after_shift");
  return hits
    .filter((rule) => cooledDown(moment, rule))
    .map((rule) => ({
      rule,
      momentId: moment.id,
      at: moment.at,
      arm: "shadow",
      holdout: holdoutAssigned(moment.id),
      bucket: flagBucket(moment.at)
    }));
}
