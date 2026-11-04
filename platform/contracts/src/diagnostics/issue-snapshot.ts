import { z } from "zod";
import { jsonValueSchema, planningStatusSchema } from "../planning/plan-forecast.js";

export const ISSUE_SNAPSHOT_FORMAT_VERSION = "1" as const;

const isoDateTime = z.string().datetime({ offset: true });

/**
 * Everything captured from the database is carried as opaque JSON rather than parsed against its
 * own schema — portal state against `portalStateSchema`, the engine input against
 * `planForecastRequestSchema`, the engine output against `planForecastResponseSchema`.
 *
 * A snapshot is evidence, not a validated artifact. Parsing here would throw away exactly the cases
 * worth keeping: `portalStateSchema` strips the portal-only fields a user-interface replay depends
 * on (`planning` above all) and rejects broken referential integrity, and a contract-violating
 * engine result is itself a bug someone will want to look at. Validation belongs at the point of
 * use — the replay tools parse what they need and report the failure plainly.
 */
const captured = jsonValueSchema.nullable();

/**
 * Which panel the Now page was rendering. The page chooses between these branches inline, so each
 * branch reports its own mode rather than this module re-deriving the choice and drifting from it.
 */
export const nowPanelModeSchema = z.enum([
  "loading",
  "activity_session",
  "feedback",
  "action_session",
  "protected_commitment",
  "sleep_due",
  "routine_due",
  "recommendation",
  "recovery",
  // Getting somewhere is the directive: the leg to a located commitment, home for sleep, or the
  // journey a trip-eligible recommendation needs.
  "travel",
  // Nothing fits, but the engine named what would resolve it: a question, or a boundary to wait out.
  "answer",
  "boundary",
  "nothing_fits"
]);

export const nowPanelViewSchema = z.object({
  mode: nowPanelModeSchema,
  headline: z.string(),
  planningStatus: planningStatusSchema.nullable(),
  planningDecisionCurrent: z.boolean(),
  currentEnergy: z.string(),
  assertedConditions: z.array(z.string()),
  countdownSeconds: z.number().int().nullable(),
  session: z
    .object({
      id: z.string(),
      status: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      targetTitle: z.string().nullable(),
      plannedMinutes: z.number(),
      plannedEndAt: isoDateTime
    })
    .nullable(),
  primary: z.object({ actionId: z.string(), title: z.string(), recommendedMinutes: z.number().nullable() }).nullable(),
  currentDirective: z
    .object({ kind: z.string(), targetId: z.string().nullable(), title: z.string(), recommendedMinutes: z.number() })
    .nullable(),
  protectedCommitmentId: z.string().nullable(),
  sleepPlanId: z.string().nullable(),
  routineStepId: z.string().nullable(),
  alternativeActionIds: z.array(z.string()),
  evidence: z.array(z.string()),
  bannerText: z.string()
});

/** What the browser sends. Everything here is the client's own account of the moment. */
export const issueSnapshotObservationSchema = z.object({
  /**
   * Required, and required to say something: a snapshot carries megabytes of state, so a capture
   * with nothing written on it is a row nobody can act on. Trimmed before the length check so
   * whitespace cannot stand in for a description, and so the stored text is what was meant.
   */
  description: z.string().trim().min(1).max(4000),
  observedAt: isoDateTime,
  timezone: z.string().min(1),
  url: z.string().max(2000),
  userAgent: z.string().max(500),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  view: nowPanelViewSchema,
  state: captured
});

export const issueSnapshotJobSchema = z.object({
  id: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  cause: z.string().nullable(),
  inputVersion: z.string().nullable(),
  availableAt: isoDateTime.nullable(),
  createdAt: isoDateTime.nullable(),
  lockedAt: isoDateTime.nullable(),
  lockedBy: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable()
});

export const issueSnapshotPlanningRunSchema = z.object({
  requestId: z.string(),
  inputVersion: z.string(),
  contractVersion: z.string(),
  engineVersion: z.string(),
  calculatedAt: isoDateTime,
  validUntil: isoDateTime,
  createdAt: isoDateTime.nullable(),
  /** The engine output. Opaque here; parse with `planForecastResponseSchema` when you use it. */
  result: captured
});

export const issueSnapshotSchema = z.object({
  formatVersion: z.literal(ISSUE_SNAPSHOT_FORMAT_VERSION),
  id: z.string(),
  description: z.string(),
  capturedAt: isoDateTime,
  client: issueSnapshotObservationSchema.omit({ description: true }),
  server: z.object({
    readAt: isoDateTime,
    state: captured,
    /**
     * The exact engine input that produced `planningRun`, recovered from the job that carried it.
     * Null when the job has aged out or no run exists — the reason is recorded rather than guessed.
     * Opaque here; parse with `planForecastRequestSchema` when you replay it.
     */
    engineRequest: captured,
    engineRequestSource: z.enum(["matching_job", "latest_job", "unavailable"]),
    planningRun: issueSnapshotPlanningRunSchema.nullable(),
    jobs: z.array(issueSnapshotJobSchema),
    changeLog: z.array(jsonValueSchema),
    health: z.object({ database: jsonValueSchema, engine: jsonValueSchema })
  }),
  /** Non-fatal problems hit while capturing. A partial snapshot beats no snapshot. */
  warnings: z.array(z.string())
});

export const issueSnapshotSummarySchema = z.object({
  id: z.string(),
  description: z.string(),
  capturedAt: isoDateTime,
  observedAt: isoDateTime,
  mode: nowPanelModeSchema,
  planningStatus: planningStatusSchema.nullable(),
  engineInputVersion: z.string().nullable(),
  sizeBytes: z.number().int(),
  /** When the problem was dealt with. Null means still outstanding. */
  reviewedAt: isoDateTime.nullable(),
  /** What was done about it — the answer to "why is this closed?" months later. */
  reviewNote: z.string().nullable()
});

/**
 * Closing a report, or reopening one closed too early.
 *
 * The note is optional but strongly worth writing: a snapshot exists because something was wrong,
 * and a row marked done with no account of what changed cannot be distinguished later from one
 * dismissed without being understood.
 */
export const issueSnapshotReviewSchema = z.object({
  reviewed: z.boolean(),
  note: z.string().trim().max(2000).optional()
});

export type NowPanelMode = z.infer<typeof nowPanelModeSchema>;
export type NowPanelView = z.infer<typeof nowPanelViewSchema>;
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;
export type IssueSnapshotObservation = z.infer<typeof issueSnapshotObservationSchema>;
export type IssueSnapshotSummary = z.infer<typeof issueSnapshotSummarySchema>;
export type IssueSnapshotReview = z.infer<typeof issueSnapshotReviewSchema>;
