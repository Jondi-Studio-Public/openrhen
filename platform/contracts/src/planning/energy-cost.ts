import { z } from "zod";
import { localDateOf } from "./cadence-due.js";

/**
 * Energy cost note (low-energy deadlines design, Part 2): what declared low energy is holding back, as Now and
 * `status` carry it. It describes and never prescribes: no "worth more than any one task", no cause, no pattern.
 * The engine derives the counts (`deriveEnergyCost`); this module parses them from the published run defensively,
 * owns the one sentence and tells an agent exactly what to do with it.
 */

const optionalIso = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((value) => value ?? null);

/** The engine's `EnergyCost` as it travels in the published plan run: dates are ISO strings. */
export const energyCostSchema = z.object({
  declaredEnergy: z.enum(["low", "medium", "high"]),
  blockedCount: z.number().int().min(1).max(10_000),
  dueSoon: z
    .array(
      z.object({
        actionId: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        deadlineAt: optionalIso
      })
    )
    .max(50)
    .default([])
});
export type EnergyCostView = z.infer<typeof energyCostSchema>;

/** Parses a published run's `recommendation.energyCost`; null when absent or malformed. */
export function parseEnergyCost(value: unknown): EnergyCostView | null {
  const parsed = energyCostSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * For agents. Relay once, never diagnose, and name the exact calls. Energy is the person's to declare: only from
 * their own words, only when it changed, and never raised to get around the cut.
 */
export const ENERGY_COST_NEXT =
  "Tell the person the text once, as a plain fact; do not repeat it on later answers, do not nag and do not guess why their energy is low. " +
  "Only if the person says they want to recover: for rest work, call rhen_session with subcommand start, action set to a recovery-energy action " +
  "(rhen_list entity actions shows each action's energy) and minutes (a whole number, 1 to 1440; ask the person how long, or use the action's minimumSessionMinutes); " +
  "for sleep, call rhen_activity with subcommand start, type sleep, target the id of the sleep plan the plan is tracking now (rhen_list entity sleep-plans; a past or future night is refused) and minutes equal to its allowedMinutes. " +
  "If the person says their energy has actually changed, call rhen_save with entityType current_availability, fields {currentEnergy: their value}, basis stated. Send it only if the person says it changed, using their own quoted words as evidence; " +
  "never set or raise it yourself to get around the cut. No answer means no change.";

export interface EnergyCostAnswer extends EnergyCostView {
  /** The one sentence to show or relay, such as "Low energy is holding back 3 actions, 1 due Thursday." */
  text: string;
  /** For agents: what to say, the exact calls when the person wants them, and what never to do. */
  next: string;
}

export interface EnergyCostAnswerInput {
  /** The published run's recommendation, opaque; only `energyCost` is read. */
  recommendation: unknown;
  energySetAt?: string | undefined;
  /** When the plan run behind the note was calculated; a note older than the last energy statement is dropped. */
  planCalculatedAt?: string | undefined;
  /** False while the plan is stale: the counts may no longer hold, so nothing is shown. Defaults to true. */
  planCurrent?: boolean | undefined;
  /** The stretch offer already on show; its action is not named again in the text (the count still includes it). */
  stretchOfferActionId?: string | undefined;
  now: Date;
  timeZone: string;
  locale: string;
}

function safeWeekday(date: Date, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(date);
  }
}

function safeLocalDate(date: Date, timeZone: string): string {
  try {
    return localDateOf(date, timeZone);
  } catch {
    return localDateOf(date, "UTC");
  }
}

/** "Low energy is holding back 3 actions, 1 due Thursday." Singular and plural right; local weekday of the date. */
export function energyCostText(
  cost: EnergyCostView,
  options: { timeZone: string; locale: string; now: Date; omitActionId?: string | undefined }
): string {
  const { timeZone, locale, now } = options;
  const level = cost.declaredEnergy[0]!.toUpperCase() + cost.declaredEnergy.slice(1);
  const count = cost.blockedCount;
  const head = `${level} energy is holding back ${count} ${count === 1 ? "action" : "actions"}`;
  const due = cost.dueSoon.filter((entry) => entry.actionId !== options.omitActionId);
  const passed = due.filter((entry) => entry.deadlineAt && new Date(entry.deadlineAt).getTime() < now.getTime());
  const ahead = due.filter((entry) => !passed.includes(entry));
  const parts: string[] = [];
  if (passed.length) parts.push(`${passed.length} past ${passed.length === 1 ? "its" : "their"} date`);
  if (ahead.length) {
    const first = ahead.map((entry) => entry.deadlineAt).find((iso): iso is string => !!iso);
    const day = (iso: string) => {
      const date = new Date(iso);
      return safeLocalDate(date, timeZone) === safeLocalDate(now, timeZone)
        ? "today"
        : safeWeekday(date, locale, timeZone);
    };
    const days = [
      ...new Set(
        ahead
          .map((entry) => entry.deadlineAt)
          .filter((iso): iso is string => !!iso)
          .map(day)
      )
    ];
    if (ahead.length === 1 && first) parts.push(`1 due ${day(first)}`);
    else if (days.length === 1) parts.push(`${ahead.length} due ${days[0]}`);
    else if (first) parts.push(`${ahead.length} due soon, the first ${day(first)}`);
    else parts.push(`${ahead.length} due soon`);
  }
  return `${head}${parts.length ? `, ${parts.join(", ")}` : ""}.`;
}

/**
 * The note for Now and `status`, or null. Hidden while the plan is not current or is older than the last energy
 * statement (the same outdated rule as the stretch offer): its counts were for energy the person no longer has.
 */
export function buildEnergyCostAnswer(input: EnergyCostAnswerInput): EnergyCostAnswer | null {
  if (input.planCurrent === false) return null;
  const raw =
    input.recommendation && typeof input.recommendation === "object" && !Array.isArray(input.recommendation)
      ? (input.recommendation as Record<string, unknown>).energyCost
      : undefined;
  if (raw === undefined) return null;
  const cost = parseEnergyCost(raw);
  if (!cost) return null;
  const energySetMs = input.energySetAt ? new Date(input.energySetAt).getTime() : NaN;
  const calculatedMs = input.planCalculatedAt ? new Date(input.planCalculatedAt).getTime() : NaN;
  if (Number.isFinite(energySetMs) && Number.isFinite(calculatedMs) && calculatedMs < energySetMs) return null;
  return {
    ...cost,
    text: energyCostText(cost, {
      timeZone: input.timeZone,
      locale: input.locale,
      now: input.now,
      omitActionId: input.stretchOfferActionId
    }),
    next: ENERGY_COST_NEXT
  };
}
