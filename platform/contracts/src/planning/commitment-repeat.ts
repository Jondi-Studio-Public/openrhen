import { z } from "zod";

/**
 * a commitment recurrence rule is "every N days" or "every N months", anchored to its start
 * date in one of four ways. See the monthly commitment recurrence design note. adds
 * "every N weeks on these weekdays". This is the one place
 * either expansion site — the engine's `resolveCommitmentRecurrenceRepeats`
 * (`engine/core/src/recurrence/recurrence.ts`) and the portal's `projectedRuleCommitments`
 * (`portal/features/schedule/week-plan.ts`) — decides whether a rule falls on a date; neither keeps
 * arithmetic of its own (invariant 1).
 *
 * Action recurrence (`ActionRecurrenceRule`, `ActionCadence`) is a different rule, with a different
 * shape, and is untouched by this file.
 */

export const monthAnchorSchema = z.enum(["day_of_month", "last_day", "nth_weekday", "last_weekday"]);
export type MonthAnchor = z.infer<typeof monthAnchorSchema>;

export const commitmentRepeatUnitSchema = z.enum(["days", "weeks", "months"]);
export type CommitmentRepeatUnit = z.infer<typeof commitmentRepeatUnitSchema>;

/**
 * A weekly rule's weekdays, 0 = Sunday .. 6 = Saturday (the `eligibleWeekdays` numbering), at least
 * one, each once, in ascending order, so two spellings of the same set can never differ in storage.
 */
export const repeatWeekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .refine((weekdays) => weekdays.every((day, index) => index === 0 || day > weekdays[index - 1]!), {
    message: "Weekdays must be listed once each, in order."
  });

export const commitmentRepeatSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("days"), intervalDays: z.number().int().positive() }),
  z.object({ unit: z.literal("weeks"), intervalWeeks: z.number().int().positive(), weekdays: repeatWeekdaysSchema }),
  z.object({ unit: z.literal("months"), intervalMonths: z.number().int().positive(), anchor: monthAnchorSchema })
]);
export type CommitmentRepeat = z.infer<typeof commitmentRepeatSchema>;

/** Sorts and de-duplicates a weekday list into the one spelling `repeatWeekdaysSchema` accepts. */
export function normalizeRepeatWeekdays(weekdays: readonly number[]): number[] {
  return [...new Set(weekdays)].sort((left, right) => left - right);
}

export { commitmentRepeatFallsOn } from "./commitment-repeat-falls-on.js";
