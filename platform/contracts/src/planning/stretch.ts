import { z } from "zod";
import { agentBasisSchema } from "../agent-proposals.js";

/**
 * Stretch offers: the person's answer to "work on this despite the energy cut, for a bounded time".
 * The command carries only the choice, the offered action and the agent evidence rule; the server takes the title and
 * the minutes from the published plan run, and sets the end itself. Pure; the server stores it.
 */

export const STRETCH_CHOICES = ["accept", "decline", "decline_all"] as const;
export type StretchChoice = (typeof STRETCH_CHOICES)[number];

export const stretchCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    choice: z.enum(STRETCH_CHOICES),
    /** The offered action (the engine's candidate id). Required for accept and decline; `decline_all` names none. */
    actionId: z.string().trim().min(1).max(200).optional(),
    /** `stated` needs the person's words as `evidence`; a missing basis reads as `inferred`. */
    basis: agentBasisSchema.default("inferred"),
    evidence: z.string().trim().min(1).max(300).optional()
  })
  .superRefine((command, context) => {
    if (command.choice !== "decline_all" && !command.actionId)
      context.addIssue({
        code: "custom",
        path: ["actionId"],
        message: "Say which action the stretch is for (actionId); only decline_all names none."
      });
    if (command.basis === "stated" && !command.evidence)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A stated answer needs the person's words as evidence."
      });
  });
export type StretchCommand = z.infer<typeof stretchCommandSchema>;

/**
 * An agent may answer a stretch only on the person's word. Accept and decline both need `basis stated` with the
 * person's own words as evidence; `decline_all` only restricts, so it may be inferred. The person's own path (no
 * agent) needs neither. Empty when nothing is wrong.
 */
export function agentStretchProblems(command: Pick<StretchCommand, "choice" | "basis">): string[] {
  if (command.choice === "decline_all" || command.basis === "stated") return [];
  return [
    "Only the person can say yes or no to a stretch. Next: ask the person; if they answered, call openrhen_stretch again with basis stated, evidence set to their own words (up to 300 characters), and a NEW command-id. If they cannot be reached, do nothing; do not raise declared energy instead."
  ];
}

const energyLevelSchema = z.enum(["low", "medium", "high"]);
const optionalIso = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((value) => value ?? null);

/** The engine's `StretchOffer` as it travels in the published plan run: dates are ISO strings, absent dates are null. */
export const stretchOfferSchema = z.object({
  actionId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  declaredEnergy: energyLevelSchema,
  requiredEnergy: energyLevelSchema,
  energyGap: z.union([z.literal(1), z.literal(2)]),
  minutes: z.number().int().min(1).max(1440),
  cappedAtMinutes: z
    .number()
    .int()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
  reason: z.enum(["overdue_external", "behind_external", "at_risk_external", "external_within_48h"]),
  externalDeadlineAt: optionalIso,
  latestSafeStartAt: optionalIso
});
export type StretchOfferView = z.infer<typeof stretchOfferSchema>;

/** Parses the JSON form of a `StretchOffer` (a published run's `recommendation.stretchOffer`); null when absent or malformed. */
export function parseStretchOffer(value: unknown): StretchOfferView | null {
  const parsed = stretchOfferSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface StretchOfferTextOptions {
  timeZone: string;
  locale: string;
  /** When the offer is made; the end time and "already passed" are measured from it. Defaults to the clock. */
  now?: Date;
}

function safeFormat(date: Date, options: Intl.DateTimeFormatOptions, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(date);
  }
}

/** A clock time such as `23:10`. */
export function stretchClock(date: Date, timeZone: string, locale: string): string {
  return safeFormat(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale, timeZone);
}

/** A date with its time such as `Wed 5 Nov, 09:00`. */
function stretchDateTime(date: Date, timeZone: string, locale: string): string {
  return safeFormat(
    date,
    { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    locale,
    timeZone
  );
}

/**
 * The one owner of the offer sentence. Neutral on purpose: it describes, names what each choice costs and says both
 * are reasonable. It says an outside deadline, never who set it (nothing records that), and it states when the
 * stretch would end. The server stores this text next to the quoted yes; Now renders from it.
 */
export function stretchOfferText(offer: StretchOfferView, options: StretchOfferTextOptions): string {
  const { timeZone, locale } = options;
  const now = options.now ?? new Date();
  const deadline = offer.externalDeadlineAt ? new Date(offer.externalDeadlineAt) : null;
  const dateClause = !deadline
    ? "has an outside deadline"
    : deadline.getTime() < now.getTime()
      ? `had an outside deadline that passed on ${stretchDateTime(deadline, timeZone, locale)}`
      : `has an outside deadline on ${stretchDateTime(deadline, timeZone, locale)}`;
  const length = offer.cappedAtMinutes
    ? `up to ${offer.minutes} minutes (the most for a two-step energy gap is ${offer.cappedAtMinutes})`
    : `${offer.minutes} minutes`;
  const end = stretchClock(new Date(now.getTime() + offer.minutes * 60_000), timeZone, locale);
  return (
    `${offer.title} ${dateClause} and needs ${offer.requiredEnergy} energy; you said ${offer.declaredEnergy}. ` +
    `You can work on it for ${length} now, ending at ${end}, knowing tired work is slower and tomorrow pays for tonight, ` +
    "or rest and come back to it fresh. Both are reasonable."
  );
}

/** The `next` sentence after an answer. */
export function stretchNextStep(
  outcome: "accepted" | "declined" | "declined_all",
  details: { title?: string; until?: string; timeZone: string; locale: string }
): string {
  if (outcome === "declined_all") return "No stretches until tomorrow; do not raise it again.";
  if (outcome === "declined")
    return `Skipped${details.title ? ` ${details.title}` : ""} for today; do not offer it again until tomorrow.`;
  const end = details.until ? stretchClock(new Date(details.until), details.timeZone, details.locale) : "the end time";
  return `Stretch started${details.title ? `: ${details.title}` : ""} until ${end}. Start it with rhen_session start. rhen_undo reverses it; re-declaring energy also ends it when the energy value changes or is asserted again.`;
}

/** What the command returns. */
export interface StretchResult {
  choice: StretchChoice;
  outcome: "accepted" | "declined" | "declined_all";
  actionId?: string;
  title?: string;
  minutes?: number;
  /** When an accepted stretch ends: set by the server, never by the caller. */
  until?: string;
  by: "person" | "agent";
  /** The exact offer sentence the answer was given to (accept only). */
  offerText?: string;
  next: string;
  /** The command id to undo with (`rhen undo`, or the owner's revert). */
  revertible: string;
}

/** Why nothing was changed, and the one call that finds out what stands now. */
export const STRETCH_NEXT_CALL = {
  tool: "rhen_status",
  arguments: {},
  note: "read-only; tell the person about a stretch only if its answer shows stretchOffer"
} as const;

/** The next step when the answer was for an action other than the one on offer. */
export const STRETCH_REASK_NEXT =
  "call rhen_status, tell the person the sentence of the offer it shows, and if they answer send openrhen_stretch again for that action with a NEW command-id.";
