import { isCadenceDueToday, type CadenceDueRule } from "@openrhen/contracts";

/**
 * this gate's day-granular math — period bounds, remaining count, `minSpacingDays`,
 * `eligibleWeekdays` — used to be reimplemented here by hand because `platform/database` cannot import
 * `@openrhen/engine-*` (`scripts/repository/check-structure.mjs`'s `platform/` rule, enforced by
 * `pnpm structure:check` — with no `.test.ts` exemption, so even a test in this package could not reach
 * across for a parity check). It now lives in `@openrhen/contracts` as `isCadenceDueToday`
 * (`platform/contracts/src/planning/cadence-due.ts`), which both this gate and the engine's own
 * `cadenceStepDueToday` (`engine/core/src/recurrence/cadence.ts`) call, so the two can no longer drift.
 *
 * `CadenceGateRule` stays as this file's own name for the subset of `ActionCadence`
 * (`engine/core/src/model/types.ts`) the gate's caller assembles from `action_recurrence_rules` plus
 * its completion log — an alias of the shared `CadenceDueRule`, kept so `routine-inheritance.ts` does
 * not need to know the math moved.
 */
export type CadenceGateRule = CadenceDueRule;

/**
 * Whether a cadence-linked routine step is eligible to appear in today's synced template —
 * `syncInheritedRoutineSteps` (`routine-inheritance.ts`) applies this to every preset step carrying a
 * `cadence_action_id`, before reconciling the template onto a commitment, so a step standing in for a
 * cadence action is only ever offered on a day that cadence is actually due — see
 * The cadence target per period design note.
 */
export function isCadenceStepEligibleToday(rule: CadenceGateRule, now: Date): boolean {
  return isCadenceDueToday(rule, now);
}
