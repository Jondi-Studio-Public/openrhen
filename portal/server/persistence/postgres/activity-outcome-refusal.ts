/**
 * The finish outcomes `rhen_activity` takes per target type. `stopped` (work still open) belongs to a deliverable and
 * `skipped` (moot preparation) to a routine step; the rest are open to every target. A refusal names the outcomes the
 * target does take, so an agent can repeat the finish with one of them.
 */
const OUTCOMES_FOR: Record<string, readonly string[]> = {
  deliverable: ["completed", "stopped", "blocked", "did_not_start"],
  routine_step: ["completed", "blocked", "did_not_start", "skipped"]
};
const COMMON_OUTCOMES = ["completed", "blocked", "did_not_start"] as const;

const list = (names: readonly string[]) => `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

/** The refusal for `outcome` on a `targetType` session, or null when that outcome is allowed. */
export function activityOutcomeRefusal(outcome: string, targetType: string): string | null {
  const allowed = list(OUTCOMES_FOR[targetType] ?? COMMON_OUTCOMES);
  const target = targetType.replace("_", " ");
  if (outcome === "stopped" && targetType !== "deliverable")
    return `Only a deliverable session can be stopped with its work still open. For this ${target} finish with ${allowed}.`;
  if (outcome === "skipped" && targetType !== "routine_step")
    return `Only a routine step's own preparation can be skipped. For this ${target} finish with ${allowed}.`;
  return null;
}
