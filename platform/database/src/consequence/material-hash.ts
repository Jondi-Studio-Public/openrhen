import { createHash } from "node:crypto";

/**
 * The material-field hash stored with every comparison answer (comparison-consequence-ranking design, 3.4 and 3.5): the
 * fields whose change makes an old answer about a different thing. The list is fixed and normalised, so the same data
 * hashes the same however it arrived (a state replace, an import, a restore): the trimmed title, the definition of done
 * (a project's is its outcome's; an action's is its completion condition), both deadlines as ISO instants, and the
 * parent id (a project's outcome, an action's project).
 *
 * Bump `MATERIAL_HASH_VERSION` when the field list or its normalisation changes; every stored hash then differs, which
 * drops every old answer from the fit, the safe direction.
 */
export const MATERIAL_HASH_VERSION = 1;

export interface MaterialFields {
  title: string;
  definitionOfDone?: string | null;
  /** Projects: external then internal deadline. Actions: deadline then latest start. */
  deadlines: readonly [Date | string | null | undefined, Date | string | null | undefined];
  parentId: string;
}

function isoInstant(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

/** The normalised field list, as the exact string that is hashed. Exposed so tests can pin the normalisation. */
export function materialFieldList(fields: MaterialFields): string {
  return JSON.stringify([
    MATERIAL_HASH_VERSION,
    fields.title.trim(),
    (fields.definitionOfDone ?? "").trim(),
    isoInstant(fields.deadlines[0]),
    isoInstant(fields.deadlines[1]),
    fields.parentId
  ]);
}

export function materialHash(fields: MaterialFields): string {
  return createHash("sha256").update(materialFieldList(fields)).digest("hex");
}
