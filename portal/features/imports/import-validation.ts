import "./private/index";
import { isHoldConflictMessage } from "./import-holds";
import {
  calendarSourceConnections,
  commitmentRepeatFallsOn,
  firstPrerequisiteCycle,
  normalizeRepeatWeekdays,
  validateLink,
  type PlanItemType,
  type PlanLinkKind,
  type ImportField,
  type ImportRecord,
  type MonthAnchor,
  type PrerequisiteKind,
  type PrerequisiteNode
} from "@openrhen/contracts";
import {
  IMPORT_RELATION_TYPES,
  REQUIRED_IMPORT_FIELDS,
  REQUIRED_RELATIONSHIPS,
  importFieldSpec
} from "@/features/imports/import-spec";

/** A field read from a cell the source had: blank is a deliberate blank, anything else is explicit. */
export function explicitField(value: unknown): ImportField {
  return value === null || value === "" || value === undefined
    ? { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true, source: "cell" }
    : { value, basis: "explicit", confidence: "high", evidence: [], needsReview: false, source: "cell" };
}

/**
 * A field whose column the source did not carry at all. Nothing to review: on an update the stored
 * value is left as it is, and on a create the field is simply missing, which validation reports.
 */
export function absentField(): ImportField {
  return { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false, source: "absent" };
}

/**
 * Whether the source never mentioned this field — a column left out of the sheet, or a field the
 * extraction did not emit at all. A field that is present but says nothing about its source is read
 * as a cell, which is what every batch stored before provenance was recorded meant by it.
 */
export function isAbsentColumn(record: Pick<ImportRecord, "fields">, name: string): boolean {
  const field = record.fields[name];
  return field === undefined || field.source === "absent";
}

export function fieldValue(record: ImportRecord, name: string): unknown {
  return record.fields[name]?.value ?? null;
}

export interface ValidateImportOptions {
  /**
   * Whether a record would update something that already exists. Only the store can answer, so the
   * browser validates without it and treats every record as a create. When it says yes, a required
   * field whose column is absent is not an error — the stored value stands — and an invariant whose
   * every field is absent is not judged, since the merged record is not in view.
   */
  isExisting?: (record: ImportRecord) => boolean;
}

/**
 * Whether an error string on an `operation: "conflict"` record is a genuine explanation from one of
 * the diffs that can produce a conflict, as opposed to leftover text from an earlier pass. This used
 * to check only for the calendar provider's own wording, which silently dropped every the roster provider conflict
 * message (it does not match "...the calendar provider..."): the record's `errors` emptied out, and
 * `resolveOperations`'s `!match` branch (key-resolution.ts) then has no error to fall back to and
 * turns what should have been a held conflict back into an ordinary create. An overlap
 * warning has no "changed in both/by both" shape at all, so it needs its own line here too.
 */
function isDiffConflictMessage(message: string): boolean {
  return (
    calendarSourceConnections().some(
      (manifest) =>
        message.includes(`changed in both ${manifest.label} and `) ||
        message.startsWith(`Removed from ${manifest.label}, but `)
    ) ||
    // A Google cancellation or removal whose commitment was edited in OpenRhen since.
    message.includes("changed in OpenRhen since") ||
    message.startsWith("Looks like ") ||
    message.includes(" differs from the plan: ") ||
    message.startsWith("Overlaps ") ||
    isHoldConflictMessage(message)
  );
}

export function validateImportRecords(input: ImportRecord[], options: ValidateImportOptions = {}): ImportRecord[] {
  const active = input.filter((record) => !record.removed);
  const counts = new Map<string, number>();
  const areaNames = new Map<string, number>();
  for (const record of active)
    counts.set(
      `${record.entityType}:${record.importKey.toLowerCase()}`,
      (counts.get(`${record.entityType}:${record.importKey.toLowerCase()}`) ?? 0) + 1
    );
  for (const record of active.filter((item) => item.entityType === "area")) {
    const name = String(fieldValue(record, "name") ?? "")
      .trim()
      .toLowerCase();
    if (name) areaNames.set(name, (areaNames.get(name) ?? 0) + 1);
  }
  const keys = new Set(active.map((record) => `${record.entityType}:${record.importKey}`));
  const dependencyGraph = new Map<string, string[]>();
  const deliverableDependencyGraph = new Map<string, string[]>();
  for (const record of active.filter((item) => item.entityType === "dependency")) {
    const action = record.relationships.actionKey,
      dependency = record.relationships.dependsOnActionKey;
    if (action && dependency) dependencyGraph.set(action, [...(dependencyGraph.get(action) ?? []), dependency]);
  }
  for (const record of active.filter((item) => item.entityType === "deliverable_dependency")) {
    const deliverable = record.relationships.deliverableKey,
      dependency = record.relationships.dependsOnDeliverableKey;
    if (deliverable && dependency)
      deliverableDependencyGraph.set(deliverable, [...(deliverableDependencyGraph.get(deliverable) ?? []), dependency]);
  }
  const prerequisiteBatchHasCycle = batchPrerequisitesHaveCycle(active);
  const batchHasCycle = graphHasCycle(dependencyGraph);
  const deliverableBatchHasCycle = graphHasCycle(deliverableDependencyGraph);
  return input.map((record) => {
    if (record.removed) return { ...record, errors: [], warnings: [] };
    if (record.operation === "delete" || record.operation === "unlink")
      return { ...record, errors: [], warnings: record.warnings };
    const errors: string[] =
      record.operation === "conflict" ? record.errors.filter((item) => isDiffConflictMessage(item)) : [];
    const warnings: string[] = [];
    if (record.importKey.startsWith("missing-")) errors.push("import_key is required.");
    if ((counts.get(`${record.entityType}:${record.importKey.toLowerCase()}`) ?? 0) > 1)
      errors.push("Duplicate import key in this batch.");
    if (
      record.entityType === "area" &&
      (areaNames.get(
        String(fieldValue(record, "name") ?? "")
          .trim()
          .toLowerCase()
      ) ?? 0) > 1
    )
      errors.push("Area names must be unique.");
    const updatesExisting = options.isExisting?.(record) === true;
    for (const name of REQUIRED_IMPORT_FIELDS[record.entityType])
      if (fieldValue(record, name) === null && !(updatesExisting && isAbsentColumn(record, name)))
        errors.push(`${name} is required.`);
    // Relationships carry no column provenance, so a required key is required on updates too.
    for (const name of REQUIRED_RELATIONSHIPS[record.entityType] ?? [])
      if (!record.relationships[name]) errors.push(`${name} is required.`);
    if (record.entityType === "dependency" && batchHasCycle) errors.push("Imported dependencies contain a cycle.");
    if (record.entityType === "deliverable_dependency" && deliverableBatchHasCycle)
      errors.push("Imported deliverable dependencies contain a cycle.");
    if (record.entityType === "entity_prerequisite" && prerequisiteBatchHasCycle)
      errors.push("Imported prerequisites contain a cycle.");
    for (const field of Object.values(record.fields)) {
      if (field.basis === "missing" && field.value !== null) errors.push("Missing fields must remain blank.");
      if ((field.basis === "inferred" || field.basis === "default") && field.needsReview)
        warnings.push("An inferred or default value needs review.");
    }
    validateValues(record, errors, updatesExisting);
    for (const [name, target] of Object.entries(record.relationships)) {
      const type = IMPORT_RELATION_TYPES[name];
      if (target && type && !keys.has(`${type}:${target}`) && !target.startsWith("existing:"))
        warnings.push(`${name} must resolve to an existing record or another row in this batch.`);
    }
    return {
      ...record,
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      // A genuine diff conflict (a provider field clash, an overlap) keeps its own
      // "conflict" operation even though it carries errors — those errors are the whole reason it is
      // held, not a fresh problem this function found, and a held record reads as "conflict",
      // not as a validation failure. Anything else
      // with errors is genuinely rejected; anything that had been rejected but now validates cleanly
      // (a reopened batch re-resolved against a database that has moved on) reverts to a plain create.
      operation:
        record.operation === "conflict"
          ? "conflict"
          : errors.length
            ? "rejected"
            : record.operation === "rejected"
              ? "create"
              : record.operation
    };
  });
}

const PREREQUISITE_KIND_VALUES: readonly string[] = ["project", "deliverable", "action"] satisfies PrerequisiteKind[];

/** The two ends of an `entity_prerequisite` row, or null while either is unread or not a kind. */
function prerequisiteEnds(record: ImportRecord) {
  const entityKind = String(fieldValue(record, "entityKind") ?? ""),
    requiresKind = String(fieldValue(record, "requiresKind") ?? "");
  const entityKey = String(fieldValue(record, "entityKey") ?? ""),
    requiresKey = String(fieldValue(record, "requiresKey") ?? "");
  if (!PREREQUISITE_KIND_VALUES.includes(entityKind) || !PREREQUISITE_KIND_VALUES.includes(requiresKind)) return null;
  return {
    entity: { kind: entityKind as PrerequisiteKind, key: entityKey },
    requires: { kind: requiresKind as PrerequisiteKind, key: requiresKey }
  };
}

/** A row is a graph edge only when its kinds are legal; the per-row errors report the rest. */
function prerequisiteEdgeIsLegal(ends: NonNullable<ReturnType<typeof prerequisiteEnds>>): boolean {
  return (
    !!ends.entity.key &&
    !!ends.requires.key &&
    (ends.entity.kind !== ends.requires.kind || ends.entity.kind === "project") &&
    !(ends.entity.kind === ends.requires.kind && ends.entity.key === ends.requires.key)
  );
}

/**
 * Whether the batch's own prerequisite rows, with its action and deliverable dependency rows, loop,
 * judged by the same rule as the stored graph (`firstPrerequisiteCycle`). Keys stand in for ids and a
 * batch deliverable or action sits in the project its row names; a loop through records the batch does
 * not carry is for the commit to find, against the stored graph.
 */
function batchPrerequisitesHaveCycle(active: ImportRecord[]): boolean {
  const rows = active.filter((record) => record.entityType === "entity_prerequisite");
  if (!rows.length) return false;
  const nodes = new Map<string, PrerequisiteNode>();
  const node = (kind: PrerequisiteKind, key: string) => {
    const id = `${kind}:${key}`;
    if (!nodes.has(id))
      nodes.set(id, { kind, id: key, title: key, complete: false, dependencyIds: [], prerequisites: [] });
    return nodes.get(id)!;
  };
  for (const record of active) {
    if (record.entityType === "deliverable" || record.entityType === "action") {
      const project = record.relationships.projectKey;
      node(record.entityType, record.importKey).projectId = project || undefined;
      if (project) node("project", project);
    }
  }
  for (const record of active) {
    if (record.entityType === "dependency") {
      const from = record.relationships.actionKey,
        to = record.relationships.dependsOnActionKey;
      if (from && to) {
        node("action", from).dependencyIds.push(to);
        node("action", to);
      }
    }
    if (record.entityType === "deliverable_dependency") {
      const from = record.relationships.deliverableKey,
        to = record.relationships.dependsOnDeliverableKey;
      if (from && to) {
        node("deliverable", from).dependencyIds.push(to);
        node("deliverable", to);
      }
    }
  }
  for (const record of rows) {
    const ends = prerequisiteEnds(record);
    if (!ends || !prerequisiteEdgeIsLegal(ends)) continue;
    node(ends.entity.kind, ends.entity.key).prerequisites.push({ kind: ends.requires.kind, id: ends.requires.key });
    node(ends.requires.kind, ends.requires.key);
  }
  return firstPrerequisiteCycle([...nodes.values()]) !== null;
}

function graphHasCycle(graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function validateValues(record: ImportRecord, errors: string[], updatesExisting = false) {
  const number = (name: string) => Number(fieldValue(record, name));
  /**
   * Whether an invariant over these fields can be judged: always on a create, and on an update
   * unless every field it reads was left out of the source, in which case the stored values it
   * would be judged against are not in view and are left as they are.
   */
  const judged = (...names: string[]) => !updatesExisting || !names.every((name) => isAbsentColumn(record, name));
  const date = (name: string) => {
    const value = fieldValue(record, name);
    if (value !== null && Number.isNaN(new Date(String(value)).getTime()))
      errors.push(`${name} must be a valid ISO date or timestamp.`);
  };
  /** An enum column takes only the values its spec lists. */
  const allowed = (name: string) => {
    const values = importFieldSpec(record.entityType, name)?.enum;
    const value = fieldValue(record, name);
    if (values && value !== null && !values.includes(String(value)))
      errors.push(`${name} must be one of: ${values.join(", ")}.`);
  };
  const score = (name: string) => {
    if (fieldValue(record, name) !== null && (!Number.isInteger(number(name)) || number(name) < 1 || number(name) > 5))
      errors.push(`${name} must be an integer from 1 to 5.`);
  };
  if (record.entityType === "area" || record.entityType === "outcome" || record.entityType === "project")
    allowed("status");
  if (
    record.entityType === "area" &&
    judged("sortOrder") &&
    (!Number.isInteger(number("sortOrder")) || number("sortOrder") < 0)
  )
    errors.push("sortOrder must be a non-negative integer.");
  if (record.entityType === "outcome") score("value");
  if (record.entityType === "project") {
    score("consequence");
    allowed("uncertainty");
    const internal = fieldValue(record, "internalDeadlineAt"),
      external = fieldValue(record, "externalDeadlineAt");
    if (internal && external && new Date(String(internal)) > new Date(String(external)))
      errors.push("Internal deadline cannot be after external deadline.");
    const override = fieldValue(record, "remainingEffortOverrideMinutes");
    if (
      override !== null &&
      (!Number.isInteger(number("remainingEffortOverrideMinutes")) || number("remainingEffortOverrideMinutes") < 0)
    )
      errors.push("remainingEffortOverrideMinutes must be a non-negative integer.");
  }
  if (record.entityType === "deliverable") {
    score("importance");
    score("consequence");
    allowed("uncertainty");
    // Workbook imports create shells. BCR lifecycle states only begin when the user opens the
    // engine-recommended deliverable, so an import cannot pretend that breakdown has started.
    allowed("status");
    const internal = fieldValue(record, "internalDeadlineAt"),
      external = fieldValue(record, "externalDeadlineAt");
    if (internal && external && new Date(String(internal)) > new Date(String(external)))
      errors.push("Internal deadline cannot be after external deadline.");
    date("internalDeadlineAt");
    date("externalDeadlineAt");
  }
  if (record.entityType === "outcome") {
    date("deadlineAt");
    date("reviewOn");
  }
  if (record.entityType === "project") {
    date("internalDeadlineAt");
    date("externalDeadlineAt");
  }
  if (record.entityType === "action") {
    score("importance");
    score("consequence");
    allowed("status");
    allowed("energy");
    const optimistic = number("optimisticMinutes"),
      expected = number("expectedMinutes"),
      pessimistic = number("pessimisticMinutes"),
      remaining = number("remainingMinutes");
    if (
      judged("optimisticMinutes", "expectedMinutes", "pessimisticMinutes") &&
      !(optimistic > 0 && optimistic <= expected && expected <= pessimistic)
    )
      errors.push("Effort must follow optimistic ≤ expected ≤ pessimistic.");
    if (judged("remainingMinutes", "pessimisticMinutes") && !(remaining >= 0 && remaining <= pessimistic))
      errors.push("Remaining effort must be between zero and pessimistic effort.");
    if (
      judged("minimumSessionMinutes", "maximumSessionMinutes") &&
      !(number("minimumSessionMinutes") > 0 && number("minimumSessionMinutes") <= number("maximumSessionMinutes"))
    )
      errors.push("Session bounds are invalid.");
    if (judged("splittable") && typeof fieldValue(record, "splittable") !== "boolean")
      errors.push("splittable must be true or false.");
    if (judged("setupMinutes") && !(Number.isInteger(number("setupMinutes")) && number("setupMinutes") >= 0))
      errors.push("setupMinutes must be a non-negative integer.");
    // Zero is allowed and meaningful here — it is how a sheet says "stop practising this regularly".
    if (
      fieldValue(record, "repeatEveryDays") !== null &&
      (!Number.isInteger(number("repeatEveryDays")) || number("repeatEveryDays") < 0)
    )
      errors.push("repeatEveryDays must be a non-negative integer.");
    date("availableFrom");
    date("deadlineAt");
    date("latestStartAt");
    const pathways = fieldValue(record, "requirementPathways");
    if (
      Array.isArray(pathways) &&
      pathways.some(
        (pathway) =>
          !pathway ||
          typeof pathway !== "object" ||
          !Array.isArray((pathway as { contextIds?: unknown }).contextIds) ||
          (pathway as { contextIds: unknown[] }).contextIds.length === 0
      )
    ) {
      errors.push("requirements has an empty pathway — remove the extra | or add conditions to it.");
    }
  }
  if (record.entityType === "condition_definition") {
    allowed("kind");
    allowed("status");
    allowed("portability");
    const travel = fieldValue(record, "travelMinutes");
    if (travel !== null && (!Number.isInteger(number("travelMinutes")) || number("travelMinutes") < 0))
      errors.push("travel_minutes must be a non-negative integer.");
    const pathways = fieldValue(record, "pathways");
    if (Array.isArray(pathways) && pathways.some((group) => !Array.isArray(group) || group.length === 0)) {
      errors.push("pathways has an empty group — remove the extra | or add conditions to it.");
    }
  }
  if (record.entityType === "entity_prerequisite") {
    allowed("entityKind");
    allowed("requiresKind");
    const ends = prerequisiteEnds(record);
    if (ends && ends.entity.kind === ends.requires.kind) {
      if (ends.entity.kind === "action")
        errors.push("Action-to-action edges belong on the Dependencies sheet, not Entity Prerequisites.");
      else if (ends.entity.kind === "deliverable")
        errors.push(
          "Deliverable-to-deliverable edges belong on the Deliverable Dependencies sheet, not Entity Prerequisites."
        );
      else if (ends.entity.key && ends.entity.key === ends.requires.key)
        errors.push("A project cannot be its own prerequisite.");
    }
  }
  if (record.entityType === "plan_link") {
    allowed("fromType");
    allowed("toType");
    allowed("kind");
    const weight = fieldValue(record, "weight");
    if (weight !== null && !(Number.isFinite(number("weight")) && number("weight") >= 0 && number("weight") <= 1))
      errors.push("weight must be a number from 0 to 1.");
    const kind = String(fieldValue(record, "kind") ?? ""),
      fromType = String(fieldValue(record, "fromType") ?? ""),
      toType = String(fieldValue(record, "toType") ?? "");
    const fromId = String(fieldValue(record, "fromId") ?? ""),
      toId = String(fieldValue(record, "toId") ?? "");
    const endTypes: readonly string[] = importFieldSpec("plan_link", "fromType")?.enum ?? [];
    const kinds: readonly string[] = importFieldSpec("plan_link", "kind")?.enum ?? [];
    if (kinds.includes(kind) && endTypes.includes(fromType) && endTypes.includes(toType)) {
      const ends = validateLink({
        kind: kind as PlanLinkKind,
        fromType: fromType as PlanItemType,
        fromId,
        toType: toType as PlanItemType,
        toId
      });
      if (!ends.ok) errors.push(ends.reason);
    }
  }
  if (record.entityType === "fixed_commitment") {
    date("startsAt");
    date("endsAt");
    const starts = String(fieldValue(record, "startsAt") ?? ""),
      ends = String(fieldValue(record, "endsAt") ?? "");
    if (starts && ends && !(new Date(starts) < new Date(ends))) errors.push("End time must be after start time.");
    allowed("status");
    for (const name of ["setupBeforeMinutes", "transitionAfterMinutes"])
      if (judged(name) && (!Number.isInteger(number(name)) || number(name) < 0))
        errors.push(`${name} must be a non-negative integer.`);
  }
  if (record.entityType === "fixed_commitment_recurrence") {
    date("startDate");
    date("endDate");
    const startDate = String(fieldValue(record, "startDate") ?? ""),
      endDate = fieldValue(record, "endDate");
    if (startDate && endDate && new Date(String(endDate)) < new Date(startDate))
      errors.push("endDate cannot be before startDate.");
    const intervalUnit = String(fieldValue(record, "intervalUnit") ?? "days");
    allowed("intervalUnit");
    allowed("monthAnchor");
    if (
      intervalUnit === "days" &&
      judged("intervalDays") &&
      (!Number.isInteger(number("intervalDays")) || number("intervalDays") <= 0)
    )
      errors.push("intervalDays must be a positive integer.");
    // An update that states the unit rewrites every repeat column together (`upserts.ts`), so it must
    // carry that unit's own columns too; otherwise it would write NULLs the pairing CHECK rejects.
    if (intervalUnit === "weeks") {
      const validWeeks = Number.isInteger(number("intervalWeeks")) && number("intervalWeeks") > 0;
      if (judged("intervalWeeks", "intervalUnit") && !validWeeks)
        errors.push("intervalWeeks must be a positive integer.");
      const weekdays = fieldValue(record, "weekdays");
      const weekdayList =
        Array.isArray(weekdays) && weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          ? normalizeRepeatWeekdays(weekdays as number[])
          : null;
      if (judged("weekdays", "intervalUnit")) {
        if (weekdays === null || (Array.isArray(weekdays) && weekdays.length === 0))
          errors.push("weekdays is required when interval_unit is weeks.");
        else if (weekdayList === null) errors.push("weekdays must be weekday names, e.g. Tue, Thu.");
      }
      if (
        startDate &&
        weekdayList &&
        weekdayList.length > 0 &&
        !Number.isNaN(new Date(startDate).getTime()) &&
        !commitmentRepeatFallsOn(
          { unit: "weeks", intervalWeeks: validWeeks ? number("intervalWeeks") : 1, weekdays: weekdayList },
          startDate,
          startDate
        )
      )
        errors.push("weekdays do not include startDate's weekday.");
    }
    if (intervalUnit === "months") {
      if (
        judged("intervalMonths", "intervalUnit") &&
        (!Number.isInteger(number("intervalMonths")) || number("intervalMonths") <= 0)
      )
        errors.push("intervalMonths must be a positive integer.");
      const monthAnchor = fieldValue(record, "monthAnchor");
      if (judged("monthAnchor", "intervalUnit") && monthAnchor === null) errors.push("monthAnchor is required.");
      const anchors = ["day_of_month", "last_day", "nth_weekday", "last_weekday"];
      if (
        startDate &&
        typeof monthAnchor === "string" &&
        anchors.includes(monthAnchor) &&
        !Number.isNaN(new Date(startDate).getTime()) &&
        !commitmentRepeatFallsOn(
          {
            unit: "months",
            intervalMonths:
              Number.isInteger(number("intervalMonths")) && number("intervalMonths") > 0 ? number("intervalMonths") : 1,
            anchor: monthAnchor as MonthAnchor
          },
          startDate,
          startDate
        )
      )
        errors.push("monthAnchor does not match startDate.");
    }
    for (const name of ["localStartTime", "localEndTime"])
      if (fieldValue(record, name) !== null && !/^\d{2}:\d{2}$/.test(String(fieldValue(record, name))))
        errors.push(`${name} must be in HH:MM format.`);
    const startTime = String(fieldValue(record, "localStartTime") ?? ""),
      endTime = String(fieldValue(record, "localEndTime") ?? "");
    if (startTime && endTime && endTime <= startTime) errors.push("localEndTime must be after localStartTime.");
    for (const name of ["setupBeforeMinutes", "transitionAfterMinutes"])
      if (judged(name) && (!Number.isInteger(number(name)) || number(name) < 0))
        errors.push(`${name} must be a non-negative integer.`);
  }
}
