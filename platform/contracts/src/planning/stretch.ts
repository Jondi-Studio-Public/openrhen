import { z } from "zod";
import { agentBasisSchema } from "../agent-proposals.js";
import type { StretchState } from "./context-model.js";
import { addLocalDays, dateOrdinal, localDateOf } from "./cadence-due.js";

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

/** The offer as Now and `status` carry it: the engine's fields, the one sentence, and what an agent does with it. */
export interface StretchOfferAnswer extends StretchOfferView {
  /** The exact sentence to show or relay (`stretchOfferText`); the portal and the evidence log use this same text. */
  text: string;
  /** When the stretch would end if accepted now. */
  endsAt: string;
  /** For agents: what to say, when to accept, and what never to do. */
  next: string;
}

/** What the stretch answers say now, apart from an open offer. Every field is absent when it has nothing to say. */
export interface StretchBlock {
  /** The accepted stretch still running. */
  active?: { actionId: string; title: string; until: string; minutes: number; by: "person" | "agent" };
  /** Stretches accepted today (local day) and the clock times they began; the note appears from the second. */
  today?: { count: number; startedAt: string[]; note: string };
  /** The loan from an earlier day, one line, for the morning after. */
  loan?: { line: string; actionId: string; title: string; minutes: number; endedAt: string };
}

/** Compact on purpose: it travels in every `status` read. */
export const STRETCH_OFFER_NEXT =
  "Tell the person the text and let them choose; both choices are reasonable. Only the person answers a stretch offer, in the portal on Now; you cannot accept or decline it for them yet, so do not try, and never raise declared energy to get around the cut. No answer means no change.";

export interface StretchAnswerInput {
  /** The published run's recommendation, opaque; only `stretchOffer` is read. */
  recommendation: unknown;
  stretch: StretchState | undefined;
  energySetAt?: string | undefined;
  /** When the plan run behind the offer was calculated; an offer older than the last energy statement is dropped. */
  planCalculatedAt?: string | undefined;
  /** False while the plan is stale: the server refuses an accept then, so no offer is shown. Defaults to true. */
  planCurrent?: boolean | undefined;
  now: Date;
  timeZone: string;
  locale: string;
}

const validMs = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** The stored answers with anything malformed treated as absent: a bad entry never throws, it just does not count. */
function usableStretch(stretch: unknown): {
  accepted: StretchState["accepted"];
  declined: StretchState["declined"];
  declinedAllAt: string | undefined;
} {
  const value = stretch && typeof stretch === "object" ? (stretch as Record<string, unknown>) : {};
  const list = (entries: unknown): Record<string, unknown>[] =>
    Array.isArray(entries) ? entries.filter((e): e is Record<string, unknown> => !!e && typeof e === "object") : [];
  return {
    accepted: list(value.accepted).filter(
      (r) =>
        typeof r.actionId === "string" &&
        typeof r.title === "string" &&
        typeof r.minutes === "number" &&
        (r.by === "person" || r.by === "agent") &&
        validMs(r.acceptedAt) !== undefined &&
        validMs(r.until) !== undefined
    ) as unknown as StretchState["accepted"],
    declined: list(value.declined).filter(
      (r) => typeof r.actionId === "string" && validMs(r.at) !== undefined
    ) as unknown as StretchState["declined"],
    declinedAllAt: validMs(value.declinedAllAt) !== undefined ? (value.declinedAllAt as string) : undefined
  };
}

function sameDay(a: string, b: Date, timeZone: string): boolean {
  return localDateOf(new Date(a), timeZone) === localDateOf(b, timeZone);
}

/**
 * The offer and the stretch block for the Now answer. The offer is the run's, minus whatever the stored answers already
 * rule out (mirroring the server's refusal, so an answer given a moment ago hides the offer before the plan
 * recalculates). Neutral by design: accepting and refusing are described alike.
 */
export function buildStretchAnswer(input: StretchAnswerInput): {
  stretchOffer: StretchOfferAnswer | null;
  stretch: StretchBlock | null;
} {
  const { now, timeZone, locale } = input;
  const stretch = usableStretch(input.stretch);
  const energySetMs = validMs(input.energySetAt);
  const accepted = stretch.accepted;

  // The engine's own rule (`resolveStretchState`): running, accepted since energy was last declared, and energy stamped.
  const active = [...accepted]
    .filter(
      (record) =>
        energySetMs !== undefined &&
        now.getTime() < new Date(record.until).getTime() &&
        new Date(record.acceptedAt).getTime() >= energySetMs
    )
    .sort((a, b) => b.until.localeCompare(a.until))[0];

  let offer: StretchOfferView | null = null;
  const raw =
    input.recommendation && typeof input.recommendation === "object" && !Array.isArray(input.recommendation)
      ? (input.recommendation as Record<string, unknown>).stretchOffer
      : undefined;
  if (raw !== undefined && input.planCurrent !== false) offer = parseStretchOffer(raw);
  if (offer) {
    const actionId = offer.actionId;
    const declinedAll = stretch.declinedAllAt ? sameDay(stretch.declinedAllAt, now, timeZone) : false;
    const declined = stretch.declined.some(
      (entry) =>
        entry.actionId === actionId &&
        sameDay(entry.at, now, timeZone) &&
        (energySetMs === undefined || new Date(entry.at).getTime() >= energySetMs)
    );
    const running = accepted.some(
      (record) =>
        record.actionId === actionId &&
        new Date(record.until).getTime() > now.getTime() &&
        energySetMs !== undefined &&
        new Date(record.acceptedAt).getTime() >= energySetMs
    );
    const outdated =
      energySetMs !== undefined &&
      input.planCalculatedAt !== undefined &&
      new Date(input.planCalculatedAt).getTime() < energySetMs;
    if (declinedAll || declined || running || outdated) offer = null;
  }

  const today = accepted
    .filter((record) => sameDay(record.acceptedAt, now, timeZone))
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  const startedAt = today.map((record) => stretchClock(new Date(record.acceptedAt), timeZone, locale));
  const block: StretchBlock = {};
  if (active)
    block.active = {
      actionId: active.actionId,
      title: active.title,
      until: active.until,
      minutes: active.minutes,
      by: active.by
    };

  if (today.length >= 1 && (offer || today.length >= 2)) {
    const count = offer ? today.length + 1 : today.length;
    const ordinal = count === 2 ? "second" : count === 3 ? "third" : `number ${count}`;
    const began = startedAt.join(" and ");
    block.today = {
      count: today.length,
      startedAt,
      note: offer
        ? `This would be your ${ordinal} stretch today; ${today.length === 1 ? "the earlier one began" : "the earlier ones began"} at ${began}.`
        : `${today.length} stretches today, begun at ${began}.`
    };
  }

  if (!active && today.length === 0) {
    const todayLocal = localDateOf(now, timeZone);
    // Keyed on the record, not its end: a stretch that ran past midnight was still last night's.
    const earlier = accepted
      .filter(
        (record) =>
          new Date(record.until).getTime() <= now.getTime() &&
          dateOrdinal(todayLocal) - dateOrdinal(localDateOf(new Date(record.acceptedAt), timeZone)) <= 7
      )
      .sort((a, b) => new Date(b.until).getTime() - new Date(a.until).getTime())[0];
    if (earlier) {
      const ended = new Date(earlier.until);
      const yesterday = addLocalDays(todayLocal, -1) === localDateOf(new Date(earlier.acceptedAt), timeZone);
      const when = yesterday
        ? "Last night"
        : new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(ended);
      block.loan = {
        line: `${when}: ${earlier.minutes} minutes of ${earlier.title}, ended ${stretchClock(ended, timeZone, locale)}`,
        actionId: earlier.actionId,
        title: earlier.title,
        minutes: earlier.minutes,
        endedAt: earlier.until
      };
    }
  }

  return {
    stretchOffer: offer
      ? {
          ...offer,
          text: stretchOfferText(offer, { timeZone, locale, now }),
          endsAt: new Date(now.getTime() + offer.minutes * 60_000).toISOString(),
          next: STRETCH_OFFER_NEXT
        }
      : null,
    stretch: Object.keys(block).length > 0 ? block : null
  };
}
