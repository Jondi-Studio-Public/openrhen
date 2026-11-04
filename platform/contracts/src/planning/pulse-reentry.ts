import { z } from "zod";
import { agentBasisSchema } from "../agent-proposals.js";
import { catchUpEntryVerdictSchema, type CatchUpEntry, type CatchUpVerdict } from "./catch-up.js";
import { localDateOf } from "./cadence-due.js";
import type { ReentryTier } from "./pulse-state.js";

/**
 * Re-entry: the one command that ends a lapsed pulse. It carries
 * the three facts the plan needs (where, how much energy, which contexts) and a settlement of the catch-up window
 * `[lastConfirmedAt, now]` whose coarseness the gap picks (`reentryTier`). All or nothing: anything missing is named
 * and nothing is written, so an agent has to get the answer from the person. Pure; the server applies the plan.
 */

export const REENTRY_FACTS = ["location", "energy", "contexts"] as const;
export type ReentryFact = (typeof REENTRY_FACTS)[number];
export const REENTRY_ENERGIES = ["high", "medium", "low", "recovery"] as const;

const reentryDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** One tap per day: nothing was recorded. It never writes `done`. */
  answer: z.literal("nothing_recorded")
});
const reentryProjectSchema = z.object({
  projectId: z.string().min(1),
  /** `keep_open`: the project's old items lapse as missed, its dates stay. `drop_all`: they are cancelled and its lapsed own dates cleared. */
  answer: z.enum(["keep_open", "drop_all"])
});

/** What the person said about the window. Which forms count depends on the tier (`REENTRY_FORMS`). */
export const reentrySettlementSchema = z.object({
  /** Entry by entry: any tier; the only form that can write `done`. At coarser tiers these are the exceptions. */
  items: z.array(catchUpEntryVerdictSchema).max(500).optional(),
  /** Tier `days` and up: one answer per local day. */
  days: z.array(reentryDaySchema).max(400).optional(),
  /** Tier `projects`: one answer per project. */
  projects: z.array(reentryProjectSchema).max(500).optional(),
  /** Tier `projects`: the soft reset. Every old item lapses as missed and every lapsed own date is cleared. */
  startFresh: z.boolean().optional()
});
export type ReentrySettlement = z.infer<typeof reentrySettlementSchema>;

export const reenterCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    /** A saved place's id. */
    locationId: z.string().trim().min(1).optional(),
    energy: z.enum(REENTRY_ENERGIES).optional(),
    /** The contexts available to the person now (condition ids); an empty list says "none". */
    contexts: z.array(z.string().trim().min(1)).max(100).optional(),
    settlement: reentrySettlementSchema.default({}),
    /** `stated` needs the person's words as `evidence`; a missing basis reads as `inferred`. */
    basis: agentBasisSchema.default("inferred"),
    evidence: z.string().trim().min(1).max(300).optional(),
    /** What happened instead; recorded with the re-entry. */
    note: z.string().trim().min(1).max(2000).optional()
  })
  .superRefine((command, context) => {
    if (command.basis === "stated" && !command.evidence)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A stated re-entry needs the person's words as evidence."
      });
  });
export type ReenterCommand = z.infer<typeof reenterCommandSchema>;

/** The forms of settlement each tier accepts. A coarser tier accepts every finer form. */
export const REENTRY_FORMS: Readonly<Record<ReentryTier, readonly ("items" | "days" | "projects" | "startFresh")[]>> = {
  none: ["items"],
  today: ["items"],
  days: ["items", "days"],
  projects: ["items", "days", "projects", "startFresh"]
};

export type ReentryEntry = Pick<
  CatchUpEntry,
  "id" | "kind" | "title" | "plannedAt" | "localDate" | "projectId" | "version"
> & { projectTitle?: string | null | undefined };

/**
 * A recurring occurrence lapses as missed without asking, and the right-now entries (an open session, the last wake,
 * the open check-in) need a time only the person has, so they stay on the catch-up ledger; the deadlines are what a
 * re-entry reviews.
 */
export function reentryReviewable(entry: Pick<ReentryEntry, "kind">): boolean {
  return entry.kind === "self_set_deadline" || entry.kind === "external_deadline";
}

/** The local day an entry belongs to for grouping: an occurrence's own day, else the day it was planned for. */
export function reentryDay(entry: Pick<ReentryEntry, "localDate" | "plannedAt">, timeZone: string): string {
  return entry.localDate ?? localDateOf(new Date(entry.plannedAt), timeZone);
}

/** Entries inside the window `[start, now]`: planned at or after the last confirmation. */
export function entriesInWindow<T extends Pick<ReentryEntry, "plannedAt">>(
  entries: readonly T[],
  windowStart: Date | null
): T[] {
  if (!windowStart) return [...entries];
  return entries.filter((entry) => new Date(entry.plannedAt).getTime() >= windowStart.getTime());
}

export interface ReentryGroups {
  /** Tier `today`: every reviewable entry, newest first. */
  items: ReentryEntry[];
  /** Tier `days`: reviewable entries per local day, newest first. */
  days: { day: string; entries: ReentryEntry[] }[];
  /** Tier `projects`: reviewable entries per project, the project with the most first. */
  projects: { projectId: string | null; title: string | null; entries: ReentryEntry[] }[];
}

/** The grouping the tier reviews by. Only the grouping the tier uses is filled; `none` reviews nothing. */
export function groupReentryEntries(
  entries: readonly ReentryEntry[],
  tier: ReentryTier,
  timeZone: string
): ReentryGroups {
  const reviewable = entries.filter(reentryReviewable);
  const groups: ReentryGroups = { items: [], days: [], projects: [] };
  if (tier === "none") return groups;
  if (tier === "today") {
    groups.items = [...reviewable];
    return groups;
  }
  if (tier === "days" || tier === "projects") {
    const byDay = new Map<string, ReentryEntry[]>();
    for (const entry of reviewable) {
      const day = reentryDay(entry, timeZone);
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
    groups.days = [...byDay]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([day, list]) => ({ day, entries: list }));
  }
  if (tier === "projects") {
    const byProject = new Map<string | null, ReentryEntry[]>();
    for (const entry of reviewable) byProject.set(entry.projectId, [...(byProject.get(entry.projectId) ?? []), entry]);
    groups.projects = [...byProject]
      .map(([projectId, list]) => ({
        projectId,
        title: list.find((entry) => entry.projectTitle)?.projectTitle ?? null,
        entries: list
      }))
      .sort((a, b) => b.entries.length - a.entries.length);
  }
  return groups;
}

type EntryVerdict = Extract<CatchUpVerdict, { entryId: string }>;

/** A verdict the plan will apply. `unrecorded` marks a bulk answer: the person did not say what happened. */
export interface ReentryVerdict {
  verdict: EntryVerdict;
  unrecorded: boolean;
}

export interface ReentryPlan {
  /** Reviewable entries nobody answered. Any left means the re-entry is refused. */
  unreviewed: ReentryEntry[];
  /** Items or forms the tier does not accept, and entry ids that are not in the window, each as a sentence. */
  problems: string[];
  /** Every verdict to apply: the explicit ones, then those the coarse answers expand to, then the lapsing occurrences. */
  verdicts: ReentryVerdict[];
  /** How many recurring occurrences lapse as missed without asking. */
  lapsing: number;
}

const isExternal = (entry: ReentryEntry) => entry.kind === "external_deadline";

/**
 * Entries re-entry never settles: an open session, a stale wake and the open check-in need a time or an answer only the
 * person has, so they stay on the catch-up ledger (`catch-up-settle`). Re-entry neither lapses them nor accepts an answer for them.
 */
export function reentryLeavesOnLedger(entry: Pick<ReentryEntry, "kind">): boolean {
  return entry.kind === "open_session" || entry.kind === "stale_wake" || entry.kind === "check_in";
}

/**
 * What a settlement does to the window's entries (design note, section 4). Rules, in order:
 * - An explicit item is the person's own answer and is applied as given; it is the only way to write `done`.
 * - Every other recurring occurrence lapses as missed without asking (`skipped`, unrecorded), or is cancelled when
 *   its project is dropped.
 * - A reviewable entry nobody named is covered by the tier's coarse answer, or it is `unreviewed`. A coarse answer
 *   never writes `done`: it carries a still-open date as it is (`pending`) and clears a lapsed own date only when
 *   the project is dropped or started fresh. An external date is never bulk: it needs its own answer at every tier
 *   that reviews anything.
 * - `none`: nothing is reviewed; the gap is short enough that the "still doing X?" line is the whole recovery.
 */
export function planReentrySettlement(
  entries: readonly ReentryEntry[],
  tier: ReentryTier,
  settlement: ReentrySettlement,
  timeZone: string
): ReentryPlan {
  const allowed = new Set(REENTRY_FORMS[tier]);
  const problems: string[] = [];
  for (const form of ["days", "projects", "startFresh"] as const) {
    const given = form === "startFresh" ? settlement.startFresh === true : (settlement[form]?.length ?? 0) > 0;
    if (given && !allowed.has(form))
      problems.push(
        `${form === "startFresh" ? "startFresh is" : `${form} answers are`} not accepted for a ${REENTRY_TIER_LABEL[tier]}: ${REENTRY_ASK[tier]}.`
      );
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const verdicts: ReentryVerdict[] = [];
  const answered = new Set<string>();
  for (const item of settlement.items ?? []) {
    const verdict: EntryVerdict = item;
    const named = byId.get(verdict.entryId);
    if (!named) {
      problems.push(`${verdict.entryId} is not an entry in this window.`);
      continue;
    }
    if (reentryLeavesOnLedger(named)) {
      problems.push(
        `${verdict.entryId} is not settled by re-entry: it stays on the catch-up ledger. Leave it out of settlement.items; after re-entry settle it with catch-up-settle.`
      );
      continue;
    }
    if (answered.has(verdict.entryId)) {
      problems.push(`${verdict.entryId} is answered twice.`);
      continue;
    }
    answered.add(verdict.entryId);
    verdicts.push({ verdict, unrecorded: false });
  }

  const days = new Set((allowed.has("days") ? settlement.days : undefined)?.map((entry) => entry.day) ?? []);
  const projectAnswers = new Map(
    (allowed.has("projects") ? settlement.projects : undefined)?.map((entry) => [entry.projectId, entry.answer]) ?? []
  );
  const fresh = allowed.has("startFresh") && settlement.startFresh === true;
  const dropped = (entry: ReentryEntry) => !!entry.projectId && projectAnswers.get(entry.projectId) === "drop_all";

  let lapsing = 0;
  const unreviewed: ReentryEntry[] = [];
  for (const entry of entries) {
    if (answered.has(entry.id) || reentryLeavesOnLedger(entry)) continue;
    if (!reentryReviewable(entry)) {
      lapsing += 1;
      verdicts.push({
        verdict: { entryId: entry.id, verdict: dropped(entry) ? "dropped" : "skipped" },
        unrecorded: true
      });
      continue;
    }
    if (tier === "none") continue;
    const day = reentryDay(entry, timeZone);
    const byProject = entry.projectId ? projectAnswers.get(entry.projectId) : undefined;
    const covered = !isExternal(entry) && (days.has(day) || byProject !== undefined || fresh);
    if (!covered) {
      unreviewed.push(entry);
      continue;
    }
    // A lapsed own date: carried as it is unless the project is dropped or started fresh.
    const clear = byProject === "drop_all" || (fresh && byProject !== "keep_open");
    verdicts.push({
      verdict: { entryId: entry.id, verdict: clear ? "skipped" : "pending" },
      unrecorded: true
    });
  }
  return { unreviewed, problems, verdicts, lapsing };
}

export const REENTRY_TIER_LABEL: Readonly<Record<ReentryTier, string>> = {
  none: "gap under 2 hours",
  today: "gap of 2 to 36 hours",
  days: "gap of 36 hours to 7 days",
  projects: "gap over 7 days"
};
/** What the tier asks, as an instruction to whoever answers. */
export const REENTRY_ASK: Readonly<Record<ReentryTier, string>> = {
  none: "nothing needs reviewing, only the three facts",
  today: "answer each item (done, skipped, dropped or still open) in settlement.items",
  days: "answer each day in settlement.days (nothing_recorded) or each item in settlement.items",
  projects:
    "answer each project in settlement.projects (keep_open or drop_all), set settlement.startFresh, or answer items"
};

/**
 * `startFresh` and `drop_all` discard a whole window's worth of the owner's items at once. An agent may send them only
 * when the owner said so (`basis: stated`, with the owner's words as evidence); an inferred one is refused.
 */
export function agentBulkResetProblems(settlement: ReentrySettlement, basis: ReenterCommand["basis"]): string[] {
  if (basis === "stated") return [];
  const problems: string[] = [];
  const fix =
    " Next: ask the owner. If the owner says yes, send rhen_reenter again with the same answers, basis stated, evidence set to the owner's own words, and a NEW command-id. If not, answer by day (settlement.days) or by item (settlement.items), or use keep_open.";
  if (settlement.startFresh === true)
    problems.push(`startFresh lapses everything at once, so only the owner can choose it.${fix}`);
  if (settlement.projects?.some((entry) => entry.answer === "drop_all"))
    problems.push(`drop_all cancels a project's items, so only the owner can choose it.${fix}`);
  return problems;
}

/**
 * Where, how much energy and which contexts are the owner's alone to say. An agent that sends any of them must have
 * asked the owner: `basis: stated` with the owner's words as `evidence`. An inferred (or unstated) basis is refused, so
 * a guess never becomes the owner's recorded situation. The person's own path is not checked here.
 */
export function agentFactsProblems(
  command: Pick<ReenterCommand, "locationId" | "energy" | "contexts" | "basis">
): string[] {
  if (command.basis === "stated") return [];
  const given = [
    ...(command.locationId ? ["location"] : []),
    ...(command.energy ? ["energy"] : []),
    ...(command.contexts !== undefined ? ["contexts"] : [])
  ];
  if (given.length === 0) return [];
  return [
    `You sent ${given.join(", ")} without basis stated, but only the owner can say these. Next: ask the owner where they are, their energy and which contexts are available now, then send rhen_reenter again with the same answers, basis stated, evidence set to the owner's own words (up to 300 characters), and a NEW command-id. If the owner cannot be reached, stop and tell them re-entry is waiting for them; do not guess or infer these. (The portal's one-tap "I'm at <place>" also re-enters.)`
  ];
}

/** Which of the three facts a command leaves out. */
export function missingReentryFacts(
  command: Pick<ReenterCommand, "locationId" | "energy" | "contexts">
): ReentryFact[] {
  const missing: ReentryFact[] = [];
  if (!command.locationId) missing.push("location");
  if (!command.energy) missing.push("energy");
  if (command.contexts === undefined) missing.push("contexts");
  return missing;
}

/** The names a rejection or a status line lists: the missing facts, then one line per unreviewed item. */
export function reentryMissingLines(facts: readonly ReentryFact[], unreviewed: readonly ReentryEntry[]): string[] {
  return [
    ...facts,
    ...unreviewed.map((entry) => `review ${entry.id} "${entry.title}" (planned ${entry.plannedAt.slice(0, 10)})`)
  ];
}

/** What `status` and the agent gate show before anything is answered: all three facts, and how many items wait. */
export function reentryRequirementLines(tier: ReentryTier, reviewable: number): string[] {
  const lines: string[] = [...REENTRY_FACTS];
  if (tier !== "none" && reviewable > 0)
    lines.push(`review ${reviewable} ${reviewable === 1 ? "item" : "items"} (${REENTRY_TIER_LABEL[tier]})`);
  return lines;
}

/** The whole pulse view an agent gets: `status` carries it as `pulse`, and the gate refusal repeats it. */
export interface PulseReentryView {
  state: "on" | "unknown" | "off" | "free" | "asleep";
  /** Why the state is `off` or `on`, e.g. `lapsed`, `reentered`; null when the recorder gave none. */
  reason: string | null;
  since: string;
  lastConfirmedAt: string | null;
  /** End of the expected-silence window holding the state, else null. */
  silenceUntil: string | null;
  reentry: {
    due: boolean;
    tier: ReentryTier;
    gapMinutes: number | null;
    /** What the re-entry still needs: the three facts, and the review. Empty when not due. */
    missing: string[];
  };
}

/** The plain instruction a refused agent call carries (design note, section 5). */
export const REENTRY_REQUIRED_INSTRUCTION =
  "You must call rhen_reenter and complete it before anything else; ask the owner for what you do not know. " +
  "Step 1: call rhen_reenter with no arguments; that is a read, and it lists the saved places, contexts and energies (with their meanings), anything to review, and an exact example call. " +
  "Step 2: ask the owner where the owner is, their energy and which contexts are available now; never guess or infer them. If the owner cannot be reached, stop and do not guess. " +
  "Step 3: call rhen_reenter again with location, energy and contexts, basis stated and evidence set to the owner's own words (and settlement-json if the read asks). " +
  "Never send startFresh or drop_all unless the owner chose it in the owner's own words. " +
  "Step 4: repeat the call that was refused.";

export const reentryRequiredBodySchema = z.object({
  code: z.literal("reentryRequired"),
  error: z.string(),
  pulse: z.object({
    state: z.string(),
    reason: z.string().nullable(),
    since: z.string(),
    lastConfirmedAt: z.string().nullable(),
    silenceUntil: z.string().nullable(),
    reentry: z.object({
      due: z.boolean(),
      tier: z.enum(["none", "today", "days", "projects"]),
      gapMinutes: z.number().nullable(),
      missing: z.array(z.string())
    })
  }),
  missing: z.array(z.string()),
  /** What can be named in the answer; absent when it could not be read. */
  choices: z
    .object({
      places: z.array(z.object({ id: z.string(), name: z.string() })),
      contexts: z.array(z.object({ id: z.string(), name: z.string() })),
      energies: z.array(z.string())
    })
    .optional(),
  /** A complete call with the first real place and context ids filled in; the values are placeholders to replace with the owner's answers. */
  example: z.string().optional()
});
export type ReentryRequiredBody = z.infer<typeof reentryRequiredBodySchema>;

/** The body of a refused agent call: the instruction, the pulse fields and `missing`, and nothing else. */
export function reentryRequiredBody(
  view: PulseReentryView,
  choices?: { places: { id: string; name: string }[]; contexts: { id: string; name: string }[] }
): ReentryRequiredBody {
  return {
    code: "reentryRequired",
    error: REENTRY_REQUIRED_INSTRUCTION,
    pulse: view,
    missing: view.reentry.missing,
    ...(choices
      ? {
          choices: { ...choices, energies: [...REENTRY_ENERGIES] },
          example: reentryExampleCall(choices)
        }
      : {})
  };
}

/** A ready-to-send call shape for the owner's answers; the ids shown are the first saved ones, to be replaced. */
export function reentryExampleCall(choices: {
  places: readonly { id: string }[];
  contexts: readonly { id: string }[];
}): string {
  const place = choices.places[0]?.id ?? "<place id from choices.places>";
  const contexts =
    choices.contexts
      .slice(0, 2)
      .map((context) => context.id)
      .join(",") || "none";
  return `rhen_reenter location=${place} energy=<high|medium|low|recovery> contexts=${contexts} basis=stated evidence="<the owner's own words>"  (replace every value with the owner's own answer; ask the owner first, never guess)`;
}

/**
 * The sentence that rejects an incomplete re-entry, naming each missing fact and unreviewed item. `reviewable` is how
 * many items this gap asks about: the settlement is mentioned only when there are some.
 */
export function incompleteReentryMessage(
  lines: readonly string[],
  problems: readonly string[],
  tier: ReentryTier,
  reviewable?: number
): string {
  const nothingToReview = tier === "none" || reviewable === 0;
  return [
    lines.length > 0
      ? `Re-entry is incomplete (${REENTRY_TIER_LABEL[tier]}); nothing was written. Still needed: ${lines.join("; ")}.`
      : `Re-entry is incomplete (${REENTRY_TIER_LABEL[tier]}); nothing was written. The three facts are complete, but the settlement was refused:`,
    ...problems,
    nothingToReview
      ? "For this gap: nothing needs reviewing, so settlement-json may be left out; only the three facts are needed. Ask the owner for what you do not know; do not guess."
      : `For this gap: ${REENTRY_ASK[tier]}. Ask the owner for what you do not know; do not guess, and do not mark anything done the owner did not say.`
  ].join(" ");
}

/** Used only when the owner has not written their own energy meanings. */
export const REENTRY_ENERGY_FALLBACK_MEANINGS: Readonly<Record<(typeof REENTRY_ENERGIES)[number], string>> = {
  high: "Deep focus",
  medium: "Steady concentration",
  low: "Light work only",
  recovery: "Rest and recovery"
};

/** What the no-argument read adds so an agent knows everything to ask and the exact call to make. */
export interface ReentryAnswerGuide {
  energies: { value: (typeof REENTRY_ENERGIES)[number]; meaning: string }[];
  /** True when the gap has nothing to review: `settlement-json` may be left out. */
  nothingToReview: boolean;
  /** The days (or items) to answer, in words; says explicitly when there are none. */
  toAnswer: string;
  /** An exact `settlement-json` for this tier built from the real entries, or null when there is nothing to review. */
  settlementExample: string | null;
  /** The complete call, to fill with the owner's own answers. */
  call: string;
}

/** The guide for a lapsed pulse: the energy options with meanings, what to answer for this tier, and an exact example. */
export function reentryAnswerGuide(input: {
  tier: ReentryTier;
  entries: readonly Pick<ReentryEntry, "id" | "kind">[];
  days: readonly { day: string; entryIds: readonly string[] }[];
  energyMeanings?: Partial<Record<(typeof REENTRY_ENERGIES)[number], string>> | null;
  places: readonly { id: string }[];
  contexts: readonly { id: string }[];
}): ReentryAnswerGuide {
  const { tier, days } = input;
  const energies = REENTRY_ENERGIES.map((value) => ({
    value,
    meaning: input.energyMeanings?.[value]?.trim() || REENTRY_ENERGY_FALLBACK_MEANINGS[value]
  }));
  const reviewable = input.entries.filter(reentryReviewable);
  const nothingToReview = tier === "none" || reviewable.length === 0;
  const place = input.places[0]?.id ?? "<place id from choices.places>";
  const contexts = input.contexts.slice(0, 2).map((context) => context.id);
  const facts = `location "${place}", energy one of ${REENTRY_ENERGIES.join("|")}, contexts "${contexts.join(",") || "none"}", basis "stated", evidence "<the owner's own words>"`;
  if (nothingToReview)
    return {
      energies,
      nothingToReview: true,
      toAnswer: "Nothing in this gap needs reviewing, so settlement-json may be left out.",
      settlementExample: null,
      call: `rhen_reenter with ${facts}`
    };
  const items = (list: readonly { id: string }[]) =>
    list.slice(0, 3).map((entry) => ({ entryId: entry.id, verdict: "pending" }));
  const external = reviewable.filter((entry) => entry.kind === "external_deadline");
  const dayAnswers = days
    .filter((group) => group.entryIds.some((id) => !external.some((entry) => entry.id === id)))
    .map((group) => ({ day: group.day, answer: "nothing_recorded" }));
  const example =
    tier === "today"
      ? { items: items(reviewable) }
      : {
          ...(dayAnswers.length > 0 ? { days: dayAnswers.slice(0, 3) } : {}),
          ...(external.length > 0 ? { items: items(external) } : {})
        };
  const toAnswer =
    tier === "today"
      ? `Answer each of the ${reviewable.length} item(s) listed in review.entries in settlement.items (verdict done, skipped, dropped or pending).`
      : `Answer each day in settlement.days (${days.map((group) => group.day).join(", ") || "none"}) with nothing_recorded, or each item in settlement.items. An external deadline always needs its own item. The ${reviewable.length} item(s) are in review.entries.`;
  return {
    energies,
    nothingToReview: false,
    toAnswer,
    settlementExample: JSON.stringify(example),
    call: `rhen_reenter with ${facts}, settlement-json ${JSON.stringify(example)} (replace every value with what the owner said; pending carries a date as it is and never means done)`
  };
}
