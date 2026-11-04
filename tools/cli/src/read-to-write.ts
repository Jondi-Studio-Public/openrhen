/**
 * Normalisers that convert one entity's *read* shape (as returned by `GET /api/state`) into the
 * shape its write command expects, for the handful of fields where the two deliberately differ.
 *
 * `save.ts` merges a stored record (`existing`, read shape) with the caller's `--set`/`--from`
 * fields before validating against the write schema. A field the caller never touched — e.g.
 * `requirementPathways` on an action, read back as `{ id, contextIds }[]` but written as
 * `string[][]` — passes straight through in the read shape and fails the write schema's stricter
 * type, even for an update that has nothing to do with that field. These normalisers run on
 * `existing` first, so the merge always starts from something the write schema accepts.
 *
 * An entity type with no entry here needs no conversion. Deliverable steps carry the same
 * `requirementPathways` read/write asymmetry, but the portal's deliverable write handler already
 * accepts both shapes (`portal/server/persistence/postgres/deliverable-write.ts`), so no entry is
 * needed there.
 */

type Fields = Record<string, unknown>;

/** `{ id, contextIds }[]` (read) -> `string[][]` (write). A value already in write shape passes through. */
function normalizeRequirementPathways(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((pathway) => {
    if (Array.isArray(pathway)) return pathway;
    if (pathway && typeof pathway === "object" && Array.isArray((pathway as Fields).contextIds))
      return (pathway as Fields).contextIds;
    return pathway;
  });
}

/**
 * The state leaves out `assumedFields` when nothing is assumed. A restatement of the stored record (an undo) must
 * say so, `[]`, because a write that sends no list leaves the server's stored one to decide, and the undo would
 * otherwise not put a list that the write changed back to empty.
 */
function normalizeAction(entity: Fields): Fields {
  const assumedFields = Array.isArray(entity.assumedFields) ? entity.assumedFields : [];
  if (!("requirementPathways" in entity)) return { ...entity, assumedFields };
  return {
    ...entity,
    assumedFields,
    requirementPathways: normalizeRequirementPathways(entity.requirementPathways)
  };
}

/** Per-entity-type read->write normalisers, keyed by `EntityTypeDef.canonical` in `save.ts`. */
export const READ_TO_WRITE_NORMALIZERS: Partial<Record<string, (entity: Fields) => Fields>> = {
  action: normalizeAction
};

/** Applies the normaliser for `canonical`, if any; otherwise returns `entity` unchanged. */
export function normalizeForWrite(canonical: string, entity: Fields): Fields {
  const normalize = READ_TO_WRITE_NORMALIZERS[canonical];
  return normalize ? normalize(entity) : entity;
}
