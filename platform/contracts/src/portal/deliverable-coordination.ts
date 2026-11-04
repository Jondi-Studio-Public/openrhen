import { z } from "zod";

/**
 * The seam between the deliverable workspace's coordinators and the portal. Two coordinators exist:
 * the built-in chat (`portal/server/imports/openai-deliverable-chat.ts`) and an external one — a
 * desktop AI app or CLI agent driving `rhen deliverable …`. Both express a change as one
 * `WorkspaceToolCall`, applied by the portal through a single implementation, so a step completed
 * from Claude Desktop lands exactly as one completed in the chat: same version guard, same blocker
 * dedupe, same session rollover, same revision re-arm.
 *
 * Titles, not ids, name steps, criteria and blockers here. The built-in chat works in titles so its
 * tool arguments stay readable; the CLI resolves ids to titles before sending. See
 * The external coordination design note.
 */

const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const titleList = z.array(shortText(200));

export const blockerCategorySchema = z.enum([
  "missing_information",
  "waiting_on_someone",
  "prerequisite",
  "tool_or_context_unavailable",
  "technical_problem",
  "energy_or_health",
  "other"
]);
export type BlockerCategory = z.infer<typeof blockerCategorySchema>;

export const criterionStateSchema = z.enum(["unsatisfied", "satisfied", "uncertain", "not_applicable"]);
export const verificationMethodSchema = z.enum([
  "llm_inspection",
  "user_confirmation",
  "submission_receipt",
  "external_result",
  "not_verifiable"
]);

/** A step to create, or — when its title already exists — extra prerequisites to splice onto it. */
export const workspaceAdditionStepSchema = z.object({
  title: shortText(200),
  expectedMinutes: z.number().int().nonnegative(),
  criteriaServed: titleList.default([]),
  dependsOnStepTitles: titleList.default([]),
  details: optionalText(2000),
  reblockOnComplete: z.object({ description: shortText(1000), category: blockerCategorySchema }).optional()
});

export const workspaceAdditionCriterionSchema = z.object({
  title: shortText(200),
  required: z.boolean().default(true),
  interpretation: optionalText(2000),
  sourceDocument: optionalText(255),
  sourceLocation: optionalText(255),
  expectedEvidence: optionalText(2000),
  verificationMethod: verificationMethodSchema.optional()
});

export const workspaceAdditionSchema = z.object({
  criteria: z.array(workspaceAdditionCriterionSchema).default([]),
  steps: z.array(workspaceAdditionStepSchema).default([])
});
export type WorkspaceAdditionContract = z.infer<typeof workspaceAdditionSchema>;

/** Steps only: a mid-flight amendment may never double as a route to changing completion criteria. */
export const planExtensionSchema = z.object({ steps: z.array(workspaceAdditionStepSchema).min(1) });

export const stepCompletionSchema = z.object({
  stepTitles: titleList.min(1),
  evidenceNote: z.string().trim().max(2000).default("")
});

export const criterionReviewSchema = z.object({
  criteria: z
    .array(
      z.object({
        title: shortText(200),
        state: criterionStateSchema,
        evidenceNote: z.string().trim().max(2000).default("")
      })
    )
    .min(1),
  summary: z.string().trim().max(4000).default("")
});

export const blockerReportSchema = z.object({
  description: shortText(1000),
  category: blockerCategorySchema.default("other"),
  /** Only the step(s) it directly stops; empty gates the whole deliverable. */
  stepTitles: titleList.default([]),
  proposedResolution: optionalText(1000)
});

export const blockerResolutionSchema = z.object({
  blockerDescription: shortText(1000),
  resolutionNote: z.string().trim().max(2000).default(""),
  /** The substance of what the blocking party said; retained as a source when present. */
  feedback: optionalText(20000)
});

/** `submit_for_result`'s payload: what is being waited on, from whom, and (optionally) how it might resolve. */
export const submissionSchema = z.object({
  waitingFor: shortText(500),
  category: blockerCategorySchema.default("waiting_on_someone"),
  proposedResolution: optionalText(1000)
});
export type SubmissionContract = z.infer<typeof submissionSchema>;

export const workspaceToolCallSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("add_to_breakdown"), addition: workspaceAdditionSchema }),
  z.object({ name: z.literal("start_carry_out"), approvalNote: z.string().trim().max(1000).nullable().default(null) }),
  z.object({ name: z.literal("extend_plan"), addition: planExtensionSchema }),
  z.object({ name: z.literal("mark_steps_complete"), completion: stepCompletionSchema }),
  z.object({ name: z.literal("begin_review") }),
  z.object({ name: z.literal("record_review"), review: criterionReviewSchema }),
  z.object({ name: z.literal("record_blocker"), report: blockerReportSchema }),
  z.object({ name: z.literal("resolve_blocker"), resolution: blockerResolutionSchema }),
  z.object({ name: z.literal("submit_for_result"), submission: submissionSchema })
]);
export type WorkspaceToolCallContract = z.infer<typeof workspaceToolCallSchema>;
export const workspaceToolNames = workspaceToolCallSchema.options.map((option) => option.shape.name.value);

/** `POST /api/deliverables/[id]/workspace` request body. */
export const workspaceMoveRequestSchema = z.object({
  call: workspaceToolCallSchema,
  /** The move's idempotency key and, for an agent, the id its undo record is kept under. Absent: the portal mints one. */
  commandId: z.string().trim().min(1).max(100).optional()
});

/**
 * Who is coordinating a deliverable right now, derived from its transcript: handed off while the
 * latest `external` row is a `pick_up`. `lastDropOffSummary` is the bridge the built-in chat resumes
 * from — nothing else of the external conversation is stored.
 */
export const handoffKindSchema = z.enum(["pick_up", "note", "drop_off"]);
export type HandoffKind = z.infer<typeof handoffKindSchema>;

export const coordinationStateSchema = z.object({
  handedOff: z.boolean(),
  tool: z.string().nullable(),
  since: z.string().datetime({ offset: true }).nullable(),
  lastDropOffSummary: z.string().nullable()
});
export type CoordinationState = z.infer<typeof coordinationStateSchema>;

/** `POST /api/deliverables/[id]/handoff` request body. */
export const handoffRequestSchema = z.object({
  kind: handoffKindSchema,
  tool: z.string().trim().min(1).max(80).default("external tool"),
  text: z.string().trim().max(20000).default("")
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

/** One transcript row as `GET /api/deliverables/[id]/chat` and the pack return it. */
export const transcriptRowSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "external"]),
  content: z.string(),
  createdAt: z.string(),
  /** Present on `external` rows only. */
  meta: z.object({ kind: handoffKindSchema, tool: z.string() }).optional()
});
export type TranscriptRow = z.infer<typeof transcriptRowSchema>;
