import type { ImportRecord } from "@openrhen/contracts";
import { IMPORT_RELATION_TYPES, importFieldRelations } from "@/features/imports/import-spec";
import { fieldValue } from "@/features/imports/import-validation";

/**
 * The records a partial commit must hold back: the blockers themselves, and every kept record whose
 * relationship points at a batch record that is being held back and is not already mapped to a
 * live entity — an action whose project is blocked cannot be written this time round, so it moves
 * with the project. Closed under repetition, since holding one back can strand another. Records so
 * carried along are told why, in a warning the next validation will replace.
 *
 * A relation carried as a record field rather than in `relationships` (see `import-spec.ts`'s
 * `asField`, e.g. a commitment's `location_key`) strands its record exactly the same way: a
 * commitment whose location was rejected must move with it, or it would commit with a `location_id`
 * naming a context that was never written.
 *
 * `mappedKeys` are the `type:key` pairs already tied to live entities: a relationship that resolves
 * to one of those does not strand the record, however the batch's own copy of that key fares.
 */
export function deferWithBlockedTargets(
  records: ImportRecord[],
  blockers: ImportRecord[],
  mappedKeys: ReadonlySet<string>
): ImportRecord[] {
  const held = new Map(blockers.map((record) => [record.id, record]));
  const heldKeys = new Set(blockers.map((record) => `${record.entityType}:${record.importKey}`));
  const isStranding = (type: string | undefined, target: unknown) =>
    typeof target === "string" &&
    !!type &&
    !!target &&
    heldKeys.has(`${type}:${target}`) &&
    !mappedKeys.has(`${type}:${target}`);
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (record.removed || held.has(record.id)) continue;
      const relationshipTargets = Object.entries(record.relationships).map(([name, target]) => ({
        type: IMPORT_RELATION_TYPES[name],
        target
      }));
      const fieldTargets = [
        ...importFieldRelations(record.entityType).map((relation) => ({
          type: relation.targetType as string,
          target: fieldValue(record, relation.name)
        })),
        // A prerequisite names both ends by a kind cell and a key cell, so it strands with either end.
        ...(record.entityType === "entity_prerequisite"
          ? [
              { type: String(fieldValue(record, "entityKind")), target: fieldValue(record, "entityKey") },
              { type: String(fieldValue(record, "requiresKind")), target: fieldValue(record, "requiresKey") }
            ]
          : [])
      ];
      const stranded = [...relationshipTargets, ...fieldTargets].find(({ type, target }) => isStranding(type, target));
      if (!stranded) continue;
      held.set(record.id, {
        ...record,
        warnings: [
          ...record.warnings,
          `Moved with ${stranded.target}, which this record depends on and which was blocked.`
        ]
      });
      heldKeys.add(`${record.entityType}:${record.importKey}`);
      grew = true;
    }
  }
  return records.filter((record) => held.has(record.id)).map((record) => held.get(record.id)!);
}
