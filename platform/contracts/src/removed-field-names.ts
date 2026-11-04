import { REMOVED_FIELD_NAMES } from "./removed-field-store.js";
import "./private/index.js";
/**
 * Field names migration 0133 renamed, whose old spellings are no longer accepted: the calendar-sharing fields do
 * not name the calendar provider, the family or a roster provider (a feature registers its own renamed fields from `./private/`). A save, a proposal or a recurring-commitment rule that still carries one
 * is refused with a message naming the current field, never read as the new one and never dropped without a word.
 * (A backup file written before the rename still restores: `upgradeLegacyTableNames` and `remapLegacyColumns` in
 * `platform/database` carry that old shape, which is stored data and not an input name.)
 */
export { REMOVED_FIELD_NAMES, registerRemovedFieldName } from "./removed-field-store.js";

/** The removed field names `fields` still carries, in the order they are listed above. */
export function removedFieldNamesIn(fields: Record<string, unknown>): string[] {
  return Object.keys(REMOVED_FIELD_NAMES).filter((name) => Object.prototype.hasOwnProperty.call(fields, name));
}

/** A refusal naming each removed field and its replacement; null when `fields` carries none. */
export function removedFieldMessage(fields: Record<string, unknown>): string | null {
  const found = removedFieldNamesIn(fields);
  if (found.length === 0) return null;
  return (
    found.map((name) => `"${name}" is no longer a field: use "${REMOVED_FIELD_NAMES[name] ?? ""}"`).join("; ") + "."
  );
}
