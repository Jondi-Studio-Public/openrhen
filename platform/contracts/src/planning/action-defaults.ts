/**
 * What an action starts with when whoever created it gave no estimate, and which of those fields are then
 * remembered as assumed (blueprint principle 8: "defaults and inferences are labelled").
 *
 * This is the one definition. The CLI's `save action` create (so also the MCP `rhen_save_action`) fills
 * from it, and anything else that has to put a not-yet-estimated action into the plan (the changeset ingest)
 * should call `withActionDefaults` rather than keep its own numbers. The names, signatures and the field list
 * below are a stable contract; change them only together with their callers.
 *
 * Assumed fields: `ASSUMABLE_ACTION_FIELDS` lists the estimate and judgement fields a person would otherwise
 * give: the three effort minutes, the minutes remaining, energy, the session range, importance, consequence,
 * whether it can be split, and setup minutes. `status`, `contexts` and `dependencyIds` also get starting values
 * but are structural (a fresh action is planned, unconstrained and depends on nothing) and are never listed as
 * assumed. Neither are fields with no default at all (dates, notes, recurrence, prep).
 *
 * Deriving what is missing: when the caller gives some of the estimate, the rest is worked out from what it gave,
 * so the result always passes the save checks (optimistic <= expected <= pessimistic, remaining <= pessimistic,
 * minimum session <= maximum session) and a lone `expectedMinutes: 15` is a valid action. The rule, in order:
 * expected is the caller's, else the remaining minutes when given and above zero, else the 60-minute default
 * held between any optimistic and pessimistic the caller gave (so a pessimistic of 20 gives an expected of 20);
 * a missing optimistic is expected; a missing pessimistic is expected, or the remaining minutes when those were
 * given above it; remaining is expected. No spread is invented, not even for an action given no figure at all:
 * three equal figures state none, so the engine pads them by the project's uncertainty (`effort.ts`), where a
 * made-up range would be planned as a stated one. A missing minimum session is 15, or the maximum if that is
 * lower, and a missing maximum session is 60, or the minimum if that is higher. With no figure of the estimate
 * given (a zero remaining is not one) this is exactly `ACTION_DEFAULTS` (60/60/60, 60 remaining, 15-60 session).
 * Every field filled this way is listed in `assumed`.
 *
 * Lifecycle, enforced where the action is saved, not here: a create stores `assumed`; an update drops a field
 * from the list once the caller names it (`assumedFieldsAfterUpdate`); a save that does not say (the portal's
 * own editor) keeps a stored field only while its value is unchanged.
 */

/** The action fields that can be remembered as assumed, in the order they are listed everywhere. */
export const ASSUMABLE_ACTION_FIELDS = [
  "optimisticMinutes",
  "expectedMinutes",
  "pessimisticMinutes",
  "remainingMinutes",
  "energy",
  "minimumSessionMinutes",
  "maximumSessionMinutes",
  "importance",
  "consequence",
  "splittable",
  "setupMinutes"
] as const;
export type AssumableActionField = (typeof ASSUMABLE_ACTION_FIELDS)[number];

/**
 * The starting values of a new action: enough to plan it from just a title and a project.
 * the flat context catalogue is retired, so a fresh action starts unconstrained (no `contexts`, no
 * `requirementPathways`) rather than defaulting to the catalogue's first entry; set `contexts` or
 * `requirementPathways` explicitly to constrain it.
 */
export const ACTION_DEFAULTS = {
  status: "planned",
  optimisticMinutes: 60,
  expectedMinutes: 60,
  pessimisticMinutes: 60,
  remainingMinutes: 60,
  splittable: true,
  setupMinutes: 0,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  importance: 3,
  consequence: 3,
  contexts: [] as readonly string[],
  dependencyIds: [] as readonly string[]
} as const;

const ASSUMABLE = new Set<string>(ASSUMABLE_ACTION_FIELDS);

/** True for a field name that can be remembered as assumed. */
export function isAssumableActionField(name: string): name is AssumableActionField {
  return ASSUMABLE.has(name);
}

/**
 * Keeps the assumable names in `names`, once each, in `ASSUMABLE_ACTION_FIELDS` order. Anything else
 * (an unknown name, a duplicate, a non-string) is dropped.
 */
export function normalizeAssumedFields(names: readonly unknown[] | null | undefined): AssumableActionField[] {
  const wanted = new Set(names ?? []);
  return ASSUMABLE_ACTION_FIELDS.filter((field) => wanted.has(field));
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The effort minutes and session range a create leaves out, worked out from the ones it gave (see the header). */
function deriveEstimates(given: Record<string, unknown>): Record<string, number> {
  const optimistic = finite(given.optimisticMinutes);
  const pessimistic = finite(given.pessimisticMinutes);
  const remaining = finite(given.remainingMinutes);
  const expected =
    finite(given.expectedMinutes) ??
    (remaining !== undefined && remaining > 0
      ? remaining
      : Math.min(pessimistic ?? Infinity, Math.max(optimistic ?? -Infinity, ACTION_DEFAULTS.expectedMinutes)));
  const minimumSession = finite(given.minimumSessionMinutes);
  const maximumSession = finite(given.maximumSessionMinutes);
  return {
    optimisticMinutes: expected,
    expectedMinutes: expected,
    pessimisticMinutes: Math.max(expected, remaining ?? 0),
    remainingMinutes: expected,
    minimumSessionMinutes:
      maximumSession === undefined
        ? ACTION_DEFAULTS.minimumSessionMinutes
        : Math.min(ACTION_DEFAULTS.minimumSessionMinutes, maximumSession),
    maximumSessionMinutes:
      minimumSession === undefined
        ? ACTION_DEFAULTS.maximumSessionMinutes
        : Math.max(ACTION_DEFAULTS.maximumSessionMinutes, minimumSession)
  };
}

/**
 * Fills every starting value `given` leaves out (a key that is missing or `undefined`; `null` counts as given
 * and is left for validation to refuse). `given` is not changed. The effort minutes and session range are worked
 * out from the ones the caller did give (see the header); the rest come from `ACTION_DEFAULTS`.
 *
 * - `entity`: `given` plus the starting values it lacked.
 * - `assumed`: the names, in `ASSUMABLE_ACTION_FIELDS` order, of the estimate and judgement fields that were
 *   filled, derived ones included. Empty when the caller gave all of them. Send it as the action's `assumedFields`.
 */
export function withActionDefaults<T extends Record<string, unknown>>(
  given: T
): { entity: Record<string, unknown>; assumed: AssumableActionField[] } {
  const entity: Record<string, unknown> = { ...given };
  const derived = deriveEstimates(given);
  for (const [field, value] of Object.entries(ACTION_DEFAULTS)) {
    if (entity[field] === undefined)
      entity[field] = field in derived ? derived[field] : Array.isArray(value) ? [...value] : value;
  }
  const assumed = ASSUMABLE_ACTION_FIELDS.filter((field) => given[field] === undefined);
  return { entity, assumed };
}

/**
 * The assumed list after an update: what was stored, minus every field the caller named in this call. Naming a
 * field says it, even when the value matches what was stored, so it stops being assumed.
 * `named` is the caller's own field names (the keys of what it sent, not of the merged record).
 */
export function assumedFieldsAfterUpdate(
  stored: readonly unknown[] | null | undefined,
  named: Iterable<string>
): AssumableActionField[] {
  const said = new Set(named);
  return normalizeAssumedFields(stored).filter((field) => !said.has(field));
}
