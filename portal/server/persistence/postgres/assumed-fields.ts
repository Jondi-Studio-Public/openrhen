import { ASSUMABLE_ACTION_FIELDS, normalizeAssumedFields, type AssumableActionField } from "@openrhen/contracts";

/** An action's assumable fields as the wire names them (`ASSUMABLE_ACTION_FIELDS`). */
export type AssumableValues = Record<AssumableActionField, unknown>;

/** The `actions` column that holds a wire field: `optimisticMinutes` is `optimistic_minutes`. */
export function assumableColumn(field: AssumableActionField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The assumable values of an `actions` row (`to_jsonb(ac)`, column names) under their wire names. */
export function assumableValuesOfRow(row: Record<string, unknown>): AssumableValues {
  return Object.fromEntries(
    ASSUMABLE_ACTION_FIELDS.map((field) => [field, row[assumableColumn(field)]])
  ) as AssumableValues;
}

/**
 * The one place that decides which of an action's fields are still assumed after a save. `actions.assumed_fields`
 * is what it returns.
 *
 * - The save says (`sent`, the action's `assumedFields`): the CLI, which knows what its caller named, computes the
 *   list itself (`withActionDefaults` on a create, `assumedFieldsAfterUpdate` on an update), so it is stored as sent.
 *   Only the assumable names are kept, once each.
 * - The save says nothing (the portal's own editor, and every other caller that restates the whole record): a new
 *   action has none assumed; an existing one keeps a stored field only while its value is unchanged. A changed
 *   value is someone giving one, and an unchanged one cannot be told from the editor sending back what it showed.
 */
export function nextAssumedFields(input: {
  sent: readonly string[] | undefined;
  /** The stored action: its assumed list and its values. Undefined for a create. */
  stored: { assumed: readonly string[]; values: AssumableValues } | undefined;
  /** The values this save writes. */
  next: AssumableValues;
}): AssumableActionField[] {
  if (input.sent !== undefined) return normalizeAssumedFields(input.sent);
  if (!input.stored) return [];
  const { assumed, values } = input.stored;
  return normalizeAssumedFields(assumed).filter((field) => Object.is(values[field], input.next[field]));
}

/**
 * A list of assumable names as a Postgres array literal, for `${pgNameArray(list)}::text[]`. Sent as text and cast
 * in SQL so the write does not depend on how the client serialises arrays: only the portal's pool is built with
 * `fetch_types`, and the engine worker and several test clients are not. The names are the fixed camelCase words of
 * `ASSUMABLE_ACTION_FIELDS` (anything else is dropped first), so nothing in them needs quoting.
 */
export function pgNameArray(names: readonly unknown[] | null | undefined): string {
  return `{${normalizeAssumedFields(names).join(",")}}`;
}
