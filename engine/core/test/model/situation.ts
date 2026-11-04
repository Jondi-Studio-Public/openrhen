import {
  conditionDefinitionSchema,
  currentSituationSchema,
  type ConditionDefinition,
  type CurrentSituation
} from "@openrhen/contracts";

/**
 * Expresses the old flat `assertedConditions` list in the typed model without changing what any of it
 * means, so tests written against the flat matcher keep testing the behaviour they were written for.
 *
 * Every held context becomes a portable capability that is being carried, which resolves to yes.
 * Anything a test requires but does not hold is simply left undefined, and an undefined context
 * fails closed to no — exactly what `!assertedConditions.includes(context)` produced.
 */
export function holding(...contextIds: string[]): {
  conditionDefinitions: ConditionDefinition[];
  currentSituation: CurrentSituation;
} {
  return {
    conditionDefinitions: contextIds.map((id) =>
      conditionDefinitionSchema.parse({ id, name: id, kind: "capability", portability: "portable" })
    ),
    currentSituation: currentSituationSchema.parse({ carrying: Object.fromEntries(contextIds.map((id) => [id, true])) })
  };
}
