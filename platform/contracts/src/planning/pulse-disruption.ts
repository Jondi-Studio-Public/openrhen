import { z } from "zod";
import { agentBasisSchema } from "../agent-proposals.js";
import { missingDisruptionFields, type Disruption, type DisruptionField } from "./pulse-state.js";

/**
 * `record_disruption` (the pulse on plan design note, sections 1 and 2): the one write that keeps a deviation on plan.
 * A deviation is `on/disrupted` only when it carries what he is doing, until when, where, which contexts are available
 * and whether it takes all of him (`missingDisruptionFields`). Every field is optional here so the server can answer an
 * incomplete one with each missing field named (422) rather than a bare schema error. `end: true` ends the active
 * disruption early. Pure; the server stores it.
 */

/** A target he is doing instead, rather than free text. */
export const disruptionTargetSchema = z.object({
  kind: z.enum(["action", "deliverable", "commitment", "project"]),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300).optional()
});
export type DisruptionTarget = z.infer<typeof disruptionTargetSchema>;

export const recordDisruptionCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    /** Ends the active disruption now; every other field is then ignored. */
    end: z.literal(true).optional(),
    /** What he is doing instead: free text, or a target. */
    doing: z.union([z.string().trim().max(300), disruptionTargetSchema]).optional(),
    /** Roughly until when. Must be in the future. */
    until: z.string().datetime({ offset: true }).optional(),
    /** A saved place's id. */
    locationId: z.string().trim().min(1).optional(),
    /** The contexts available to him meanwhile (condition ids); at least one. */
    contexts: z.array(z.string().trim().min(1)).max(100).optional(),
    /** Whether the commitment takes all of him (true) or he could still do other things (false). */
    exclusive: z.boolean().optional(),
    basis: agentBasisSchema.default("inferred"),
    evidence: z.string().trim().min(1).max(300).optional()
  })
  .superRefine((command, context) => {
    if (command.basis === "stated" && !command.evidence)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A stated disruption needs the person's words as evidence."
      });
  });
export type RecordDisruptionCommand = z.infer<typeof recordDisruptionCommandSchema>;

/** The longest a disruption may run; beyond it the person is not disrupted, the plan is wrong. */
export const DISRUPTION_MAX_MINUTES = 14 * 24 * 60;

/** The text a command's `doing` stands for: the free text, else the target's title, else its kind. */
export function disruptionDoingText(doing: RecordDisruptionCommand["doing"]): string | null {
  if (typeof doing === "string") return doing.trim() === "" ? null : doing.trim();
  if (doing) return doing.title ?? doing.kind;
  return null;
}

/** The command as the state machine's `Disruption`, so the same check names what is missing. */
export function disruptionOf(
  command: Pick<RecordDisruptionCommand, "doing" | "until" | "locationId" | "contexts" | "exclusive">
): Disruption {
  return {
    doing: disruptionDoingText(command.doing),
    until: command.until ? new Date(command.until) : null,
    locationId: command.locationId ?? null,
    contexts: command.contexts ?? null,
    exclusive: command.exclusive ?? null
  };
}

export function missingCommandDisruptionFields(
  command: Pick<RecordDisruptionCommand, "doing" | "until" | "locationId" | "contexts" | "exclusive">
): DisruptionField[] {
  return missingDisruptionFields(disruptionOf(command));
}

export const DISRUPTION_FIELD_HELP: Readonly<Record<DisruptionField, string>> = {
  doing: "doing (what he is doing instead)",
  until: "until (roughly when it ends)",
  locationId: "locationId (where he is, a saved place)",
  contexts: "contexts (what is available to him, at least one)",
  exclusive: "exclusive (true if it takes all of him, false if he could still do other things)"
};

/** The sentence a refusal carries: each missing field by name, and that nothing was recorded. */
export function incompleteDisruptionMessage(missing: readonly DisruptionField[]): string {
  return `A deviation stays on plan only when it is recorded with everything the plan needs; missing: ${missing
    .map((field) => DISRUPTION_FIELD_HELP[field])
    .join("; ")}. Nothing was recorded. Ask the person for what you do not know.`;
}

/** The active disruption as `status` and the portal read it. */
export interface PulseDisruptionView {
  doing: string;
  until: string;
  locationId: string;
  contexts: string[];
  exclusive: boolean;
  recordedBy: "person" | "agent";
}
