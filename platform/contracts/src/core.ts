import { z } from "zod";

export const energyTypeSchema = z.enum(["high", "medium", "low", "recovery"]);
export type EnergyType = z.infer<typeof energyTypeSchema>;

export const uncertaintySchema = z.enum(["known", "some", "high"]);
export type Uncertainty = z.infer<typeof uncertaintySchema>;

export const projectHealthSchema = z.enum(["ahead", "on_track", "at_risk", "behind", "unknown"]);
export type ProjectHealth = z.infer<typeof projectHealthSchema>;

/**
 * What a project's health measures: "feasibility" (whether remaining effort fits before a deadline —
 * every project before this existed) or "adherence" (a maintenance project's own basis — every live
 * action is recurring or cadence, so health tracks period completion instead; see
 * `engine/core/src/scheduling/adherence.ts`).
 */
export const projectHealthBasisSchema = z.enum(["feasibility", "adherence"]);
export type ProjectHealthBasis = z.infer<typeof projectHealthBasisSchema>;

/**
 * The status every area, outcome and project shares. A deliverable, a commitment recurrence rule,
 * and a routine preset each have their own status word and are not this one.
 */
export const lifecycleStatusSchema = z.enum(["active", "paused", "done", "cancelled", "archived"]);
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

export const actionStatusSchema = z.enum([
  "inbox",
  "planned",
  "active",
  "doing",
  "waiting",
  "blocked",
  "done",
  "cancelled",
  "archived"
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;
