import {
  findCompositeCycles,
  type ConditionDefinition,
  type ImportEntityType,
  type ImportRecord,
  type PlanLinkInput
} from "@openrhen/contracts";
import { IMPORT_RELATION_TYPES, importFieldRelations } from "@/features/imports/import-spec";
import { fieldValue, validateImportRecords } from "@/features/imports/import-validation";
import { checkPlanLink } from "../plan-map-store";
import type { Sql } from "../sql-pool";

/**
 * Validates the records and decides what each one would do — create, update, delete, conflict —
 * against what the database already holds. Validation runs in here rather than before it, because
 * whether a required field may be absent depends on whether the record is an update of something
 * that exists, and only the key lookup can say.
 */
export async function resolveOperations(sql: Sql, userId: string, input: ImportRecord[]): Promise<ImportRecord[]> {
  const keys = await sql<
    { entity_type: ImportEntityType; import_key: string; entity_id: string; version: number | null }[]
  >`
    SELECT k.entity_type, k.import_key, k.entity_id,
      COALESCE(ar.version, o.version, p.version, d.version, ac.version, fc.version, crr.version) AS version
    FROM import_entity_keys k
    LEFT JOIN areas ar ON k.entity_type='area' AND ar.id=k.entity_id
    LEFT JOIN outcomes o ON k.entity_type='outcome' AND o.id=k.entity_id
    LEFT JOIN projects p ON k.entity_type='project' AND p.id=k.entity_id
    LEFT JOIN deliverables d ON k.entity_type='deliverable' AND d.id=k.entity_id
    LEFT JOIN actions ac ON k.entity_type='action' AND ac.id=k.entity_id
    LEFT JOIN commitments fc ON k.entity_type='fixed_commitment' AND fc.id=k.entity_id
    LEFT JOIN commitment_recurrence_rules crr ON k.entity_type='fixed_commitment_recurrence' AND crr.id=k.entity_id
    WHERE k.user_id=${userId}
  `;
  const byKey = new Map(keys.map((row) => [`${row.entity_type}:${row.import_key}`, row]));
  // condition_definition is keyed by its own slug (see condition_definitions PK), not a generated uuid,
  // so it never goes through import_entity_keys — existence alone decides create versus update.
  const existingConditionRows = await sql<
    { id: string; kind: string; status: string; pathways: unknown }[]
  >`SELECT id, kind, status, pathways FROM condition_definitions WHERE user_id=${userId}`;
  const existingConditionIds = new Set(existingConditionRows.map((row) => row.id));
  const records = validateImportRecords(input, {
    isExisting: (record) =>
      record.entityType === "condition_definition"
        ? existingConditionIds.has(record.importKey)
        : byKey.get(`${record.entityType}:${record.importKey}`)?.version != null
  });
  const existingAreas = await sql<{ id: string; name: string }[]>`SELECT id, name FROM areas WHERE user_id=${userId}`;
  const areaByName = new Map(existingAreas.map((area) => [area.name.trim().toLowerCase(), area.id]));
  const available = new Set([...byKey.keys(), ...records.map((record) => `${record.entityType}:${record.importKey}`)]);
  const relationTypes = IMPORT_RELATION_TYPES;

  const batchConditionRecords = new Map(
    records
      .filter((record) => record.entityType === "condition_definition" && !record.removed)
      .map((record) => [record.importKey, record])
  );
  const availableConditionIds = new Set([...existingConditionIds, ...batchConditionRecords.keys()]);
  // A context is keyed by its own slug rather than through import_entity_keys, so a key naming one
  // resolves against the catalogue: what already exists, plus what this batch is about to write.
  for (const id of existingConditionIds) available.add(`condition_definition:${id}`);
  // What each context will be once the batch has been written, for a key that must name a kind of
  // context rather than any of them. An archived context is not something new work may point at.
  // A batch context record already carrying an error (from validateImportRecords, before this
  // function's own checks run) will be rejected and never written, so it must not stand in for what
  // this batch will actually leave behind — otherwise a commitment could resolve its location_key
  // against a context that gets held back, and commit with a field pointing nowhere.
  const conditionKinds = new Map(
    existingConditionRows.filter((row) => row.status !== "archived").map((row) => [row.id, row.kind])
  );
  for (const [id, record] of batchConditionRecords) {
    if (record.errors.length) continue;
    const kind = String(fieldValue(record, "kind") ?? conditionKinds.get(id) ?? "");
    if ((fieldValue(record, "status") ?? "active") === "archived") conditionKinds.delete(id);
    else conditionKinds.set(id, kind);
  }
  const existingPathwaysById = new Map(
    existingConditionRows.map((row) => [row.id, Array.isArray(row.pathways) ? (row.pathways as string[][]) : []])
  );
  const mergedDefinitions = [...availableConditionIds].map((id) => {
    const batchRecord = batchConditionRecords.get(id);
    const pathways = batchRecord
      ? Array.isArray(fieldValue(batchRecord, "pathways"))
        ? (fieldValue(batchRecord, "pathways") as string[][])
        : []
      : (existingPathwaysById.get(id) ?? []);
    return { id, pathways };
  });
  const cyclicConditionIds = new Set(findCompositeCycles(mergedDefinitions as unknown as ConditionDefinition[]));

  // A `link` or `unlink` names a commitment that already exists; its
  // version is read here so commit can write against what is stored now.
  // A series link names a repeating commitment instead; an ended rule reads as cancelled.
  const linkTargetsOf = (entityType: string) => [
    ...new Set(
      records.flatMap((record) =>
        (record.operation === "link" || record.operation === "unlink") &&
        record.matchedEntityId &&
        record.entityType === entityType
          ? [record.matchedEntityId]
          : []
      )
    )
  ];
  const commitmentTargets = linkTargetsOf("fixed_commitment");
  const ruleTargets = linkTargetsOf("fixed_commitment_recurrence");
  const targetVersions = new Map([
    ...(commitmentTargets.length
      ? (
          await sql<
            { id: string; version: number; status: string }[]
          >`SELECT id, version, status FROM commitments WHERE user_id=${userId} AND id IN ${sql(commitmentTargets)}`
        ).map((row) => [row.id, row] as const)
      : []),
    ...(ruleTargets.length
      ? (
          await sql<
            { id: string; version: number; status: string }[]
          >`SELECT id, version, CASE WHEN status='active' THEN 'active' ELSE 'cancelled' END AS status FROM commitment_recurrence_rules WHERE user_id=${userId} AND id IN ${sql(ruleTargets)}`
        ).map((row) => [row.id, row] as const)
      : [])
  ]);

  // A plan link is checked against the same rules as a hand-made one: ends the kind allows, ends that
  // exist, and a pair that was rejected. Done up front because the check reads the database.
  const planLinkRefusals = new Map<string, string>();
  for (const record of records) {
    if (record.entityType !== "plan_link" || record.removed || record.errors.length) continue;
    const refusal = await checkPlanLink(sql, userId, planLinkInput(record));
    if (refusal) planLinkRefusals.set(record.id, refusal.reason);
  }

  return records.map((record) => {
    const match = byKey.get(`${record.entityType}:${record.importKey}`);
    if ((record.operation === "link" || record.operation === "unlink") && !record.removed) {
      const target = record.matchedEntityId ? targetVersions.get(record.matchedEntityId) : undefined;
      const version = target?.version;
      if (version === undefined || !target)
        return {
          ...record,
          operation: "conflict" as const,
          errors: [
            ...record.errors,
            `Commitment ${record.matchedEntityId ?? record.importKey} (named by this ${record.operation}) no longer exists, so nothing was linked. Run the import preview again to pick up the current commitments.`
          ],
          expectedVersion: null
        };
      // A link is made against the commitment as previewed: one edited since (or cancelled) is asked again.
      const previewed = record.relationships.sourceMatchVersion;
      const stale =
        record.operation === "link" &&
        (target.status === "cancelled" || (previewed !== undefined && Number(previewed) !== version));
      if (stale)
        return {
          ...record,
          operation: "conflict" as const,
          errors: [
            ...record.errors,
            target.status === "cancelled"
              ? "The matched record changed after preview: it has since been cancelled."
              : "The matched record changed after preview."
          ],
          expectedVersion: null
        };
      return {
        ...record,
        operation: record.errors.length && record.operation === "link" ? ("rejected" as const) : record.operation,
        expectedVersion: version
      };
    }
    const unresolved = [
      ...Object.entries(record.relationships).flatMap(([name, target]) =>
        target && relationTypes[name] && !available.has(`${relationTypes[name]}:${target}`)
          ? [`${name} does not resolve to an imported or previously mapped ${relationTypes[name]}.`]
          : []
      ),
      // An edge's two ends name a project, deliverable or action by a kind cell, so the target type is
      // read from the row rather than from the column.
      ...(record.entityType === "entity_prerequisite"
        ? [
            ["entityKind", "entityKey", "entity_key"],
            ["requiresKind", "requiresKey", "requires_key"]
          ].flatMap(([kindName, keyName, header]) => {
            const kind = fieldValue(record, kindName!),
              key = fieldValue(record, keyName!);
            return typeof kind === "string" && typeof key === "string" && key && !available.has(`${kind}:${key}`)
              ? [`${header} does not resolve to an imported or previously mapped ${kind}.`]
              : [];
          })
        : []),
      // A relation carried as a field is checked here rather than above, and by its header, which is
      // the word the reader typed under in their sheet.
      ...importFieldRelations(record.entityType).flatMap((relation) => {
        const target = fieldValue(record, relation.name);
        if (typeof target !== "string" || !target) return [];
        if (relation.targetConditionKind)
          return conditionKinds.get(target) === relation.targetConditionKind
            ? []
            : [`${relation.header} must name an active ${relation.targetConditionKind} context.`];
        return available.has(`${relation.targetType}:${target}`)
          ? []
          : [
              `${relation.header} does not resolve to an imported or previously mapped ${relation.targetType.replaceAll("_", " ")}.`
            ];
      })
    ];
    const duplicateArea =
      record.entityType === "area"
        ? areaByName.get(
            String(fieldValue(record, "name") ?? "")
              .trim()
              .toLowerCase()
          )
        : undefined;
    const duplicateErrors =
      duplicateArea && duplicateArea !== match?.entity_id ? ["An area with this name already exists."] : [];
    const cycleErrors =
      record.entityType === "condition_definition" && cyclicConditionIds.has(record.importKey)
        ? ["This capability's pathways are part of a circular composite definition."]
        : [];
    const conditionReferenceErrors =
      record.entityType === "action" ? unknownConditionReferences(record, availableConditionIds) : [];
    const base = {
      ...record,
      errors: [...record.errors, ...duplicateErrors, ...cycleErrors, ...conditionReferenceErrors],
      warnings: record.warnings.filter((warning) => !warning.includes("must resolve to an existing record"))
    };
    const checked = unresolved.length
      ? { ...base, errors: [...base.errors, ...unresolved], operation: "rejected" as const }
      : base;
    if (
      checked.entityType === "dependency" ||
      checked.entityType === "deliverable_dependency" ||
      checked.entityType === "entity_prerequisite"
    )
      return {
        ...checked,
        operation: checked.errors.length ? "rejected" : "create",
        expectedVersion: null,
        matchedEntityId: null
      };
    if (checked.entityType === "plan_link") {
      // Create only: a plan link has no stored key to update, and an import never deletes one.
      const errors = [
        ...checked.errors,
        ...(checked.operation === "delete"
          ? ["An import cannot delete a plan link; remove it from the plan map."]
          : []),
        ...(planLinkRefusals.has(checked.id) ? [planLinkRefusals.get(checked.id)!] : [])
      ];
      return {
        ...checked,
        errors,
        operation: errors.length ? "rejected" : "create",
        expectedVersion: null,
        matchedEntityId: null
      };
    }
    if (checked.entityType === "condition_definition") {
      const exists = existingConditionIds.has(checked.importKey);
      return {
        ...checked,
        operation: checked.errors.length ? "rejected" : exists ? "update" : "create",
        expectedVersion: null,
        matchedEntityId: exists ? checked.importKey : null
      };
    }
    if (!match)
      return {
        ...checked,
        // A brand-new record (nothing in import_entity_keys yet) that the diff already flagged as a
        // conflict — another source's D3 overlap against another confirmed commitment, which has no
        // existing entity of its own to "match" — must stay a conflict rather than fall through to
        // "rejected" or (worse, before `isDiffConflictMessage` above stopped discarding its error
        // text) silently becoming "create". Reaching the owner as "rejected" would read as a hard failure
        // rather than the two-sided "Apply anyway / Don't add" choice it actually is.
        operation:
          checked.operation === "delete" || checked.operation === "conflict"
            ? "conflict"
            : checked.errors.length
              ? "rejected"
              : "create",
        expectedVersion: null,
        // A held source match names the commitment it would join; that target must survive resolution.
        matchedEntityId: checked.relationships.sourceMatchCommitmentId ? checked.matchedEntityId : null
      };
    if (match.version === null)
      return {
        ...checked,
        operation: "conflict",
        errors: [
          ...checked.errors,
          `The entity ${match.entity_id} that ${record.entityType} "${record.importKey}" was imported as before no longer exists, so this record is held as a conflict. Keep the new copy or drop the record in the import preview.`
        ],
        matchedEntityId: match.entity_id,
        expectedVersion: null
      };
    const stale = checked.expectedVersion !== null && checked.expectedVersion !== match.version;
    return {
      ...checked,
      operation: stale
        ? "conflict"
        : checked.operation === "delete"
          ? "delete"
          : checked.operation === "conflict" && checked.errors.length
            ? "conflict"
            : checked.errors.length
              ? "rejected"
              : "update",
      matchedEntityId: match.entity_id,
      expectedVersion: match.version,
      errors: stale ? [...checked.errors, "The matched record changed after preview."] : checked.errors
    };
  });
}

function unknownConditionReferences(record: ImportRecord, availableConditionIds: Set<string>): string[] {
  const pathways = Array.isArray(fieldValue(record, "requirementPathways"))
    ? (fieldValue(record, "requirementPathways") as { contextIds?: unknown }[])
    : [];
  const preferences = Array.isArray(fieldValue(record, "preferences"))
    ? (fieldValue(record, "preferences") as unknown[])
    : [];
  const referenced = [
    ...pathways.flatMap((pathway) => (Array.isArray(pathway.contextIds) ? pathway.contextIds : [])),
    ...preferences
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const unknown = [...new Set(referenced)].filter((id) => !availableConditionIds.has(id));
  return unknown.length
    ? [
        `requirements or prefers references a condition that does not exist: ${unknown.join(", ")}. Use one of: ${[...availableConditionIds].sort().join(", ") || "(none defined yet)"}.`
      ]
    : [];
}

/** What a `plan_link` record asks for, as the store's link input. */
export function planLinkInput(record: ImportRecord): PlanLinkInput {
  const weight = fieldValue(record, "weight");
  const evidence = fieldValue(record, "evidence");
  return {
    fromType: String(fieldValue(record, "fromType")) as PlanLinkInput["fromType"],
    fromId: String(fieldValue(record, "fromId")),
    toType: String(fieldValue(record, "toType")) as PlanLinkInput["toType"],
    toId: String(fieldValue(record, "toId")),
    kind: String(fieldValue(record, "kind")) as PlanLinkInput["kind"],
    weight: weight === null ? null : Number(weight),
    evidence: Array.isArray(evidence) ? evidence.map(String) : []
  };
}
