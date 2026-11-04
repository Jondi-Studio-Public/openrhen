import { z } from "zod";
import { energyTypeSchema } from "../core.js";
import { requirementPathwaySchema } from "./context-model.js";

/**
 * What the Deliverable Workspace tells the planning engine about a deliverable.
 *
 * The workspace decides what work exists; the engine decides when that work receives attention. This
 * projection is the whole of the boundary between them. It is derived deterministically from accepted
 * state, so the same accepted deliverable and calculation time reproduce the same engine result.
 *
 * Nothing probabilistic crosses this line. No document text, no rubric interpretation, no LLM
 * proposal, no chat history, and no unconfirmed suggestion belongs in a projection — only facts the
 * user has already accepted.
 */

const isoDateTime = z.string().datetime({ offset: true });

/**
 * One way to spend time on this deliverable right now. Options are the currently executable steps,
 * so their effort does not sum to `remainingMinutes` — most remaining work is usually still gated
 * behind prerequisites.
 */
export const executionOptionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    optimisticMinutes: z.number().int().positive(),
    expectedMinutes: z.number().int().positive(),
    pessimisticMinutes: z.number().int().positive(),
    remainingMinutes: z.number().int().min(0),
    energy: energyTypeSchema,
    minimumSessionMinutes: z.number().int().positive(),
    maximumSessionMinutes: z.number().int().positive(),
    splittable: z.boolean().default(true),
    setupMinutes: z.number().int().min(0).default(0),
    /** Satisfied when ANY pathway holds. Empty means the step states no requirement. */
    requirementPathways: z.array(requirementPathwaySchema).default([])
  })
  .superRefine((option, context) => {
    if (!(option.optimisticMinutes <= option.expectedMinutes && option.expectedMinutes <= option.pessimisticMinutes)) {
      context.addIssue({ code: "custom", message: "Execution option estimates are out of order." });
    }
    if (option.minimumSessionMinutes > option.maximumSessionMinutes) {
      context.addIssue({ code: "custom", message: "Execution option session range is invalid." });
    }
  });

export const deliverableProjectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum([
    "needs_breakdown",
    "ready",
    "in_progress",
    "under_review",
    "awaiting_result",
    "ready_to_complete",
    "completed",
    "cancelled",
    "archived"
  ]),
  /** Contract and plan both approved. False means the deliverable has not agreed what its work is. */
  approved: z.boolean(),
  /**
   * Total remaining effort across unfinished steps. Null when the breakdown is unapproved: the amount
   * is unknown, and unknown must never be reported as zero.
   */
  remainingMinutes: z.number().int().min(0).nullable(),
  /** Shortest option available, so the engine can exclude the deliverable when too little time remains. */
  minimumUsefulSessionMinutes: z.number().int().positive().nullable(),
  /** Open blockers exist but at least one option remains — the deliverable is still worth recommending. */
  partiallyBlocked: z.boolean().default(false),
  hasOpenBlockers: z.boolean().default(false),
  /** Every prerequisite deliverable is complete. */
  dependenciesSatisfied: z.boolean().default(true),
  /**
   * Named, not merely counted, so the exclusion can say which deliverable is in the way rather than
   * reporting an unexplained number.
   */
  incompletePrerequisites: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).default([]),
  uncertainty: z.enum(["known", "some", "high"]),
  importance: z.number().int().min(1).max(5),
  consequence: z.number().int().min(1).max(5),
  externalDeadlineAt: isoDateTime.optional(),
  internalDeadlineAt: isoDateTime.optional(),
  lastWorkedAt: isoDateTime.optional(),
  /** Empty means nothing can be worked on now, whatever the remaining effort says. */
  executionOptions: z.array(executionOptionSchema).default([]),
  /**
   * Whether the breakdown has defined any step at all, accepted or not. Distinguishes "the breakdown
   * itself is the only work" (true provisional case: no steps yet, so an unrestricted placeholder is
   * fair) from "steps exist but none are executable right now" (a real step's own requirements, e.g.
   * a location, are unmet — that must never be reported as unconstrained just because the contract
   * hasn't been formally approved yet).
   */
  hasSteps: z.boolean().default(false)
});

export type ExecutionOption = z.infer<typeof executionOptionSchema>;
export type DeliverableProjection = z.infer<typeof deliverableProjectionSchema>;
