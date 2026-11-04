import { z } from "zod";
import { offsetDateTime } from "../iso-datetime.js";
import { agentBasisSchema } from "../agent-proposals.js";
import { spanLabel } from "./freshness.js";

/**
 * Catch-up after a break. The ledger is derived on read: everything that
 * should have had an outcome and has none. A verdict settles one entry; `settle_catch_up` applies a
 * batch through the one write path.
 */

/** A catch-up is due once this many hours have passed with nothing recorded and the ledger is not empty. */
export const CATCH_UP_DUE_AFTER_HOURS = 36;
/** Occurrences older than this are not listed unless the caller names an earlier `since`. */
export const CATCH_UP_OCCURRENCE_LOOKBACK_DAYS = 30;
/** One ledger page. */
export const CATCH_UP_PAGE_SIZE = 50;
export const CATCH_UP_MAX_VERDICTS = 500;

export const CATCH_UP_ENTRY_KINDS = [
  "occurrence",
  "self_set_deadline",
  "external_deadline",
  "open_session",
  "stale_wake",
  "check_in"
] as const;
export const catchUpEntryKindSchema = z.enum(CATCH_UP_ENTRY_KINDS);
export type CatchUpEntryKind = z.infer<typeof catchUpEntryKindSchema>;

/**
 * `ended` is an open session's own: it stopped at `at` without being finished. Each entry lists the
 * verdicts it takes (`verdicts`), so a caller never has to know the per-kind rules.
 */
export const CATCH_UP_VERDICTS = ["done", "ended", "skipped", "dropped", "pending"] as const;
export const catchUpVerdictNameSchema = z.enum(CATCH_UP_VERDICTS);
export type CatchUpVerdictName = z.infer<typeof catchUpVerdictNameSchema>;

/** What an unanswered check-in asks, in catch-up: the plan's belief at that slot, aged as `spanLabel` says it. */
export function checkInCatchUpQuestion(title: string, slotAt: string, now: Date): string {
  return `Were you on ${title} ${spanLabel(now.getTime() - new Date(slotAt).getTime())} ago?`;
}

export const catchUpEntrySchema = z.object({
  /**
   * `occurrence:<id>`, `deadline:<projectId>`, `session:<id>`, `wake` or `check-in:<id>`; the handle a
   * verdict names.
   */
  id: z.string().min(1),
  kind: catchUpEntryKindSchema,
  title: z.string(),
  /**
   * When it was planned: an occurrence window's end, the lapsed deadline, an open session's planned end
   * (or when it was paused), the last wake, or a check-in's slot.
   */
  plannedAt: offsetDateTime(),
  /** What to ask the person, in the words every surface uses; null where the title says it. */
  question: z.string().nullable(),
  /** The verdicts this entry accepts; `at` is required where `atRequired` says so. */
  verdicts: z.array(catchUpVerdictNameSchema).min(1),
  /** Verdicts that need an `at`: when it stopped (a session) or when he woke (the wake). */
  atRequired: z.array(catchUpVerdictNameSchema),
  /** An action session's `ended` also takes the effort still left (`remainingMinutes`); nothing else does. */
  asksRemainingMinutes: z.literal(true).optional(),
  /** The local day it belongs to, for grouping (occurrences only). */
  localDate: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The project's name, for grouping by project; absent on an entry stored before it existed. */
  projectTitle: z.string().nullable().optional(),
  /**
   * The row's version when read (deadlines, sessions, check-ins, the wake's settings); null for an
   * occurrence, which a status guard protects.
   */
  version: z.number().int().nullable()
});
export type CatchUpEntry = z.infer<typeof catchUpEntrySchema>;

/**
 * The pulse's view of the same window: when the pulse is `off/lapsed` the window
 * is `[lastConfirmedAt, now]` and its size picks how coarsely it is reviewed. Groups hold entry ids only, so the
 * list above stays the one place an entry's details live. Absent when the pulse has not lapsed.
 */
export const catchUpReentrySchema = z.object({
  tier: z.enum(["none", "today", "days", "projects"]),
  lastConfirmedAt: offsetDateTime().nullable(),
  gapMinutes: z.number().nonnegative().nullable(),
  /** Entries inside the pulse window that the person reviews (an occurrence lapses as missed without asking). */
  reviewable: z.number().int().nonnegative(),
  /** Recurring occurrences in the window that `reenter` lapses as missed without asking. */
  lapsing: z.number().int().nonnegative(),
  /** Tier `days` and `projects`: reviewable entries per local day, newest first. */
  days: z.array(z.object({ day: z.string(), entryIds: z.array(z.string()) })),
  /** Tier `projects`: reviewable entries per project. */
  projects: z.array(
    z.object({ projectId: z.string().nullable(), title: z.string().nullable(), entryIds: z.array(z.string()) })
  )
});
export type CatchUpReentry = z.infer<typeof catchUpReentrySchema>;

export const catchUpLedgerSchema = z.object({
  now: offsetDateTime(),
  /** The last moment anything was recorded by the person (or the last closed catch-up). Null: never. With a lapsed pulse: the pulse's last confirmation. */
  since: offsetDateTime().nullable(),
  /** Whether the banner should offer catch-up: the pulse is `off/lapsed`, or the 36 hour rule below says so. */
  due: z.boolean(),
  /** The pulse window's tiered grouping; present only while the pulse is `off/lapsed`. */
  reentry: catchUpReentrySchema.optional(),
  unsettled: z.number().int().nonnegative(),
  staleDates: z.number().int().nonnegative(),
  entries: z.array(catchUpEntrySchema),
  /** Entries not in this page. */
  remaining: z.number().int().nonnegative(),
  /**
   * The `offset` that reads the next page, or null on the last. Offsets count the dated entries only: the
   * right-now ones ride on the first page as extras, so a page can hold more than `CATCH_UP_PAGE_SIZE`.
   */
  nextOffset: z.number().int().nonnegative().nullable()
});
export type CatchUpLedger = z.infer<typeof catchUpLedgerSchema>;

const dateTime = offsetDateTime();

export const catchUpEntryVerdictSchema = z.object({
  entryId: z.string().min(1),
  verdict: catchUpVerdictNameSchema,
  /** When it happened (`done`), stopped (`ended`) or when he woke (the wake's `done`); not in the future. */
  at: dateTime.optional(),
  /** `ended` on an action session: the effort still left. Absent: the estimate is flagged for review. */
  remainingMinutes: z.number().int().min(0).optional(),
  /** `pending` on a deadline: the new date. */
  moveTo: dateTime.optional(),
  /** `dropped` on a deadline: what the project becomes. */
  becomes: z.enum(["paused", "done"]).optional(),
  /** The version the caller read (deadlines); a mismatch is a conflict for that entry. */
  version: z.number().int().nullable().optional()
});

const scopedBulkVerdictSchema = z.object({
  bulk: z.enum(["all_skipped", "all_dropped"]),
  /** Narrow to one local day (`YYYY-MM-DD`). */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Narrow to one project. */
  projectId: z.string().min(1).optional()
});

/** The longest look-back `skip_older_than` takes; ten years is "everything". */
export const CATCH_UP_SKIP_OLDER_THAN_MAX_DAYS = 3650;

/**
 * Everything planned more than `days` days ago becomes `skipped`, across the whole window: occurrences,
 * lapsed self-set dates (the date is cleared, the work kept) and check-ins. Entries that need a time
 * (an open session, the wake) and external dates (which cannot be skipped) are left listed.
 */
const olderThanBulkVerdictSchema = z
  .object({
    bulk: z.literal("skip_older_than"),
    days: z.number().int().min(0).max(CATCH_UP_SKIP_OLDER_THAN_MAX_DAYS)
  })
  // Strict: a `day` or `projectId` here would otherwise be stripped and the skip run across everything.
  .strict();

export const CATCH_UP_BULKS = ["all_skipped", "all_dropped", "skip_older_than"] as const;

export const catchUpVerdictSchema = z.union([
  catchUpEntryVerdictSchema,
  scopedBulkVerdictSchema,
  olderThanBulkVerdictSchema
]);
export type CatchUpVerdict = z.infer<typeof catchUpVerdictSchema>;

export const settleCatchUpCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    verdicts: z.array(catchUpVerdictSchema).min(1).max(CATCH_UP_MAX_VERDICTS),
    /** Close the window: accepted only when nothing remains unsettled after these verdicts. */
    closeWindow: z.boolean().default(false),
    /** `stated` needs the person's words as `evidence`; a missing basis reads as `inferred`. */
    basis: agentBasisSchema.default("inferred"),
    evidence: z.string().trim().min(1).max(300).optional(),
    /** What happened instead; recorded with the settle. */
    note: z.string().trim().min(1).max(2000).optional()
  })
  .superRefine((command, context) => {
    if (command.basis === "stated" && !command.evidence)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A stated verdict needs the person's words as evidence."
      });
    command.verdicts.forEach((verdict, index) => {
      if ("bulk" in verdict && verdict.bulk === "all_dropped" && !verdict.projectId)
        context.addIssue({
          code: "custom",
          path: ["verdicts", index, "projectId"],
          message: "all_dropped needs a projectId."
        });
    });
  });
export type SettleCatchUpCommand = z.infer<typeof settleCatchUpCommandSchema>;

export const CATCH_UP_OUTCOMES = ["applied", "unchanged", "conflict", "invalid"] as const;
export const catchUpEntryResultSchema = z.object({
  entryId: z.string(),
  outcome: z.enum(CATCH_UP_OUTCOMES),
  message: z.string().optional()
});
export const settleCatchUpResultSchema = z.object({
  results: z.array(catchUpEntryResultSchema),
  closed: z.boolean(),
  remaining: z.number().int().nonnegative(),
  /**
   * False when an agent's settle was not kept for undo: it ended an activity session, whose finish closes rows
   * no snapshot holds. Absent otherwise.
   */
  revertible: z.literal(false).optional()
});
export type SettleCatchUpResult = z.infer<typeof settleCatchUpResultSchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The one due rule: something is unsettled and nothing was recorded for the threshold. A null `since` is never recorded. */
export function catchUpDue(since: Date | null, unsettled: number, now: Date): boolean {
  const quietFor = since ? now.getTime() - since.getTime() : Number.POSITIVE_INFINITY;
  return unsettled > 0 && quietFor >= CATCH_UP_DUE_AFTER_HOURS * HOUR_MS;
}

/** One push per away window: the window's start names it, so a new absence sends again. */
export function catchUpNudgeDedupeKey(since: Date): string {
  return `catch-up-due:${since.toISOString()}`;
}

/** The "your plan is waiting" push. Whole days away, at least one. */
export function composeCatchUpNudge(since: Date, unsettled: number, now: Date): { title: string; body: string } {
  const days = Math.max(1, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
  const things = unsettled === 1 ? "1 thing" : `${unsettled} things`;
  return {
    title: "Your plan is waiting",
    body: `You've been away ${days === 1 ? "1 day" : `${days} days`}. ${things} to settle.`
  };
}
