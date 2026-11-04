import {
  calendarSourceConnections,
  type ImportBatch,
  type ImportEntityType,
  type ImportField,
  type ImportRecord
} from "@openrhen/contracts";
import {
  calendarConflictProvider,
  conflictFieldsKey,
  defaultConflictProvider,
  remoteValueKey
} from "@/features/imports/calendar-conflict";
import { setCalendarRecordsSelected } from "./calendar-selection";
import { enterLinkConflict } from "./source-match-conflicts";
import { derivedField, importDefault, userField } from "./import-field-values";
import "./private/index";
import {
  holdCancelKeys,
  holdCancelPrefixes,
  holdOverlapErrorPrefixes,
  holdOverlapRelationshipKeys
} from "./import-holds";
import { validateImportRecords } from "./import-validation";
import type { PortalState } from "@/state/portal-state";

/**
 * Every edit made on the review screen is a whole-batch replacement that also drops the batch back
 * to `draft`, because a batch the user has touched can no longer claim the validation result the
 * server last gave it. Keeping the transforms pure means the page holds nothing but the state.
 */
export type ImportRecordFilter = "all" | "ready" | "needs" | "warnings" | "rejected";

export interface LocationImportDefaults {
  conditionDefinitions: PortalState["conditionDefinitions"];
  routinePresets: PortalState["routinePresets"];
  defaultSetupBufferMinutes: number;
  defaultTransitionBufferMinutes: number;
}

/**
 * Errors only the store can reach a verdict on: a key that resolves nowhere, a name something else
 * already has, a record that moved on since the preview. The browser cannot re-judge them, so an
 * edit somewhere else in the batch must not quietly clear them — they stand until the draft is saved
 * and the server has looked again.
 */
const SERVER_ONLY_ERRORS = [
  "does not resolve to an imported or previously mapped",
  "already exists",
  "no longer exists",
  "changed after preview",
  "circular composite definition",
  "references a condition that does not exist"
];

export const isServerOnlyImportError = (error: string) => SERVER_ONLY_ERRORS.some((part) => error.includes(part));

/**
 * Re-runs the shared validator over the edited batch so that a row just put right loses its red line
 * at once and the counts above the list move with it, instead of standing still until the draft is
 * saved. The browser cannot ask whether a record updates something that already exists — only the
 * store can — so it validates as it always has, treating every record as a create, and keeps the
 * findings only the store could have made. `operation` is left exactly as the server set it: what a
 * record will do is the server's answer, and a browser that has not spoken to it must not restate it.
 *
 * The batch drops to `draft` in the same step. What the server last said about it no longer
 * describes what is on screen, and only a batch the server has validated can be committed.
 */
function draft(batch: ImportBatch, records: ImportRecord[]): ImportBatch {
  const validated = validateImportRecords(records);
  return {
    ...batch,
    status: "draft",
    records: records.map((record, index) => ({
      ...record,
      errors: [...new Set([...validated[index]!.errors, ...record.errors.filter(isServerOnlyImportError)])],
      warnings: validated[index]!.warnings
    }))
  };
}

function mapRecord(batch: ImportBatch, recordId: string, change: (record: ImportRecord) => ImportRecord): ImportBatch {
  return draft(
    batch,
    batch.records.map((record) => (record.id === recordId ? change(record) : record))
  );
}

export function filterImportRecords(records: ImportRecord[], filter: ImportRecordFilter): ImportRecord[] {
  return records.filter(
    (record) =>
      filter === "all" ||
      (filter === "ready" && !record.removed && !record.errors.length && !record.warnings.length) ||
      (filter === "needs" && record.errors.some((item) => item.includes("required"))) ||
      (filter === "warnings" && record.warnings.length > 0) ||
      (filter === "rejected" && (record.removed || record.errors.length > 0))
  );
}

/**
 * Whether a record still stops a commit: kept, and either invalid or conflicting. A `rejected`
 * operation is not asked about separately, because the store only ever rejects a record that carries
 * the errors which caused it — and after an edit here the errors are the fresher answer of the two.
 */
export const isBlockingImportRecord = (record: ImportRecord) =>
  !record.removed && (record.errors.length > 0 || record.operation === "conflict");

export function countBlockingImportRecords(records: ImportRecord[]): number {
  return records.filter(isBlockingImportRecord).length;
}

/**
 * The import keys the batch itself would create or update, by entity type, so a relationship key can
 * be offered from what is in view rather than typed blind. Removed records are left out: a key that
 * will not be written is not a target.
 */
export function importKeysByType(records: ImportRecord[]): Partial<Record<ImportEntityType, string[]>> {
  const keys: Partial<Record<ImportEntityType, string[]>> = {};
  for (const record of records) {
    if (record.removed || record.importKey.startsWith("missing-")) continue;
    (keys[record.entityType] ??= []).push(record.importKey);
  }
  return keys;
}

export function updateRecordField(batch: ImportBatch, recordId: string, name: string, raw: string): ImportBatch {
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    fields: { ...record.fields, [name]: userField(raw, name) }
  }));
}

/**
 * A default the reader chose to accept. It counts as a cell they filled in — an absent column that
 * is defaulted during review is a value they mean to write, not one they mean to leave alone — and
 * stays marked `default` so the card still says where it came from.
 */
const defaultField = (value: unknown): ImportField => ({
  value,
  basis: "default",
  confidence: null,
  evidence: ["Applied by user"],
  needsReview: false,
  source: "cell"
});

/** Fills in the column's default for this entity, if it has one; a field with no default is left alone. */
export function applyRecordDefault(batch: ImportBatch, recordId: string, name: string): ImportBatch {
  const target = batch.records.find((record) => record.id === recordId);
  const value = target ? importDefault(target.entityType, name) : undefined;
  if (value === undefined) return batch;
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    fields: { ...record.fields, [name]: defaultField(value) }
  }));
}

/**
 * The blank fields in these records a default could fill: the same offer the card makes field by
 * field, gathered so it can be accepted once. A record on its way out — removed, or a delete — is
 * not filled in: nothing about it is going to be written.
 */
function blankDefaultNames(record: ImportRecord): string[] {
  if (record.removed || record.operation === "delete") return [];
  return Object.entries(record.fields)
    .filter(([name, field]) => field.value === null && importDefault(record.entityType, name) !== undefined)
    .map(([name]) => name);
}

export function countBlankDefaults(records: readonly ImportRecord[]): number {
  return records.reduce((total, record) => total + blankDefaultNames(record).length, 0);
}

/**
 * Applies every column default that has a blank to fill across the records given — the ones on
 * screen, so a filter narrows what the button touches to what the reader can see. A batch with
 * nothing to fill is returned unchanged, which keeps a pointless press from dropping it to `draft`.
 */
export function applyBlankDefaults(batch: ImportBatch, records: readonly ImportRecord[]): ImportBatch {
  const names = new Map(records.map((record) => [record.id, blankDefaultNames(record)]));
  if (!countBlankDefaults(records)) return batch;
  return draft(
    batch,
    batch.records.map((record) => {
      const blanks = names.get(record.id);
      if (!blanks?.length) return record;
      return {
        ...record,
        fields: {
          ...record.fields,
          ...Object.fromEntries(blanks.map((name) => [name, defaultField(importDefault(record.entityType, name))]))
        }
      };
    })
  );
}

/**
 * Drops the records that still block a commit — removing them rather than deleting them, so the
 * batch keeps saying what arrived and the decision can be taken back one row at a time.
 */
export function removeBlockingRecords(batch: ImportBatch, records: readonly ImportRecord[]): ImportBatch {
  const blocked = new Set(records.filter(isBlockingImportRecord).map((record) => record.id));
  if (!blocked.size) return batch;
  return draft(
    batch,
    batch.records.map((record) => (blocked.has(record.id) ? { ...record, removed: true } : record))
  );
}

export function toggleRecordRemoved(batch: ImportBatch, recordId: string): ImportBatch {
  return mapRecord(batch, recordId, (record) => ({ ...record, removed: !record.removed }));
}

export function setCalendarSelection(batch: ImportBatch, selected: boolean): ImportBatch {
  return draft(batch, setCalendarRecordsSelected(batch.records, selected));
}

export function updateRecordRelationship(
  batch: ImportBatch,
  recordId: string,
  name: string,
  value: string
): ImportBatch {
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    relationships: { ...record.relationships, [name]: value.trim() || null }
  }));
}

/**
 * Choosing a saved location carries its buffers and its default preparation routine onto the record.
 * An unrecognised place falls back to the global buffer settings rather than leaving the field blank.
 *
 * `knownId` is for a place the caller has already resolved — one just created from a geocoder match,
 * say — rather than one the reader typed a name for. It is trusted over the name match, so a place
 * that has not yet reached `defaults.conditionDefinitions` (it was only just saved) still gets its key
 * written rather than being silently dropped for want of a name to match on.
 */
export function applyRecordLocation(
  batch: ImportBatch,
  recordId: string,
  value: string,
  defaults: LocationImportDefaults,
  knownId?: string
): ImportBatch {
  const profile = defaults.conditionDefinitions.find((item) =>
    knownId
      ? item.id === knownId
      : item.kind === "location" && item.status === "active" && item.name.toLowerCase() === value.trim().toLowerCase()
  );
  const resolvedId = profile?.id ?? knownId;
  const preset = profile?.defaultRoutinePresetId
    ? defaults.routinePresets.find((item) => item.id === profile.defaultRoutinePresetId)
    : undefined;
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    fields: {
      ...record.fields,
      location: userField(value, "location"),
      // Naming a saved place is choosing it: the key follows the label, so the two cannot disagree.
      // A label that names no saved place leaves whatever key the record already had alone — the
      // free text is a description of the place, not a way to unset it. A known id is different: it
      // is already the reader's choice, not a name to be matched, so it is always written.
      ...(resolvedId ? { locationId: userField(resolvedId, "locationId") } : {}),
      setupBeforeMinutes: profile
        ? derivedField(profile.setupBeforeMinutes, profile.name)
        : userField(String(defaults.defaultSetupBufferMinutes), "setupBeforeMinutes"),
      transitionAfterMinutes: profile
        ? derivedField(profile.transitionAfterMinutes, profile.name)
        : userField(String(defaults.defaultTransitionBufferMinutes), "transitionAfterMinutes")
    },
    relationships: {
      ...record.relationships,
      locationProfileId: resolvedId ?? null,
      routinePresetId: preset?.id ?? null,
      routineSteps: preset ? JSON.stringify(preset.steps) : null
    }
  }));
}

export function selectRecordRoutine(
  batch: ImportBatch,
  recordId: string,
  presetId: string,
  routinePresets: PortalState["routinePresets"]
): ImportBatch {
  const preset = routinePresets.find((item) => item.id === presetId);
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    relationships: {
      ...record.relationships,
      routinePresetId: preset?.id ?? null,
      routineSteps: preset ? JSON.stringify(preset.steps) : null
    }
  }));
}

export function patchRecordRoutineSteps(batch: ImportBatch, recordId: string, steps: unknown[]): ImportBatch {
  return mapRecord(batch, recordId, (record) => ({
    ...record,
    relationships: { ...record.relationships, routineSteps: steps.length ? JSON.stringify(steps) : null }
  }));
}

/** The chosen side of a conflict as a field. A list (weekdays) keeps its elements; typed text would flatten it to a string. */
function resolvedField(value: unknown, name: string) {
  if (Array.isArray(value)) return { ...userField("x", name), value };
  return userField(value === null || value === undefined ? "" : String(value), name);
}

/**
 * Resolving one conflicted field clears that field's remote copy and its error. The record stays a
 * conflict until nothing is left to decide, at which point it becomes an ordinary update.
 */
export function resolveRecordSharedCalendarConflict(
  batch: ImportBatch,
  recordId: string,
  name: string,
  useRemote: boolean
): ImportBatch {
  return mapRecord(batch, recordId, (record) => {
    // A source joining a commitment whose values differ: the same choice, resolving to the link, not an update.
    if ("sourceMatchConflictFields" in record.relationships) {
      const remaining = String(record.relationships.sourceMatchConflictFields ?? "")
        .split("|")
        .filter((item) => item && item !== name);
      const remote = record.relationships[`sourceMatchRemote:${name}`];
      const value = useRemote && remote ? JSON.parse(remote) : (record.fields[name]?.value ?? null);
      return {
        ...record,
        operation: remaining.length ? ("conflict" as const) : ("link" as const),
        matchedEntityId: record.matchedEntityId ?? record.relationships.sourceMatchCommitmentId ?? null,
        relationships: {
          ...record.relationships,
          sourceMatchConflictFields: remaining.length ? remaining.join("|") : null
        },
        fields: { ...record.fields, [name]: userField(value === null ? "" : String(value), name) },
        errors: record.errors.filter((item) => !item.startsWith(`${name} differs from the plan`))
      };
    }
    const provider = calendarConflictProvider(record) ?? defaultConflictProvider();
    const fieldsKey = conflictFieldsKey(provider);
    const remoteKey = remoteValueKey(provider, name);
    const remaining = String(record.relationships[fieldsKey] ?? "")
      .split("|")
      .filter((item) => item && item !== name);
    const relationships = {
      ...record.relationships,
      [fieldsKey]: remaining.length ? remaining.join("|") : null,
      [remoteKey]: null
    };
    let value = record.fields[name]?.value ?? null;
    if (useRemote && record.relationships[remoteKey]) value = JSON.parse(record.relationships[remoteKey]!);
    return {
      ...record,
      operation: remaining.length ? ("conflict" as const) : ("update" as const),
      relationships,
      fields: { ...record.fields, [name]: resolvedField(value, name) },
      errors: record.errors.filter((item) => !item.startsWith(`${name} changed in both`))
    };
  });
}

/**
 * "Apply anyway" on an overlap clash: Jon has
 * looked at both commitments side by side and wants the new one written despite the clash, so the
 * held record is released back to whatever it would have been without the overlap check — a create,
 * or (for a change to an owned commitment) an update — by dropping the overlap
 * relationship and its error line. The other named commitment is left exactly as it is; this never
 * touches it.
 */
export function acceptRecordOverlap(batch: ImportBatch, recordId: string): ImportBatch {
  return mapRecord(batch, recordId, (record) => {
    const dropped = new Set(holdOverlapRelationshipKeys());
    const relationships = Object.fromEntries(
      Object.entries(record.relationships).filter(([name]) => !dropped.has(name))
    );
    const releasing = ["Overlaps ", ...holdOverlapErrorPrefixes()];
    return {
      ...record,
      operation: record.matchedEntityId ? ("update" as const) : ("create" as const),
      relationships,
      errors: record.errors.filter((item) => !releasing.some((prefix) => item.startsWith(prefix)))
    };
  });
}

/** The error lines a held cancel carries, from a sender or a calendar sync, that "Cancel anyway" clears. */
const heldCancelPrefixes = () => [
  ...holdCancelPrefixes(),
  "Cancelled in Google Calendar, but ",
  ...calendarSourceConnections().map((manifest) => `Removed from ${manifest.label}, but `),
  "No longer on this Google calendar for this date range, but "
];

/** Whether a record is a cancel held because the commitment was edited in OpenRhen since. */
export function isHeldCancel(record: Pick<ImportRecord, "relationships">): boolean {
  return Boolean(
    record.relationships.remoteCancelEdited || holdCancelKeys().some((name) => record.relationships[name])
  );
}

/**
 * "Cancel anyway" on a cancel of a commitment edited in OpenRhen since, whether a
 * a sender cancelled it or its Google event was cancelled or left the calendar: the owner has seen
 * what the cancel throws away, so the held record goes back to the delete it was. "Keep it" is the
 * ordinary Remove, which leaves the commitment (and tells a sender no).
 */
export function acceptRecordCancel(batch: ImportBatch, recordId: string): ImportBatch {
  return mapRecord(batch, recordId, (record) => {
    const dropped = new Set(["remoteCancelEdited", ...holdCancelKeys()]);
    const relationships = Object.fromEntries(
      Object.entries(record.relationships).filter(([name]) => !dropped.has(name))
    );
    return {
      ...record,
      operation: "delete" as const,
      relationships,
      errors: record.errors.filter((item) => !heldCancelPrefixes().some((prefix) => item.startsWith(prefix)))
    };
  });
}

/** Names the source-matching relationships (`source-match-records.ts`) so a match can be undone whole. */
const isSourceMatchRelationship = (name: string) => name.startsWith("sourceMatch");

/**
 * The answer on a row matched to a commitment already on the plan.
 * "Same event" links the remote event to it; "Keep both" puts the row back as the create it was, with
 * its match forgotten. Both drop the "Looks like ..." hold, so a Possible row stops blocking.
 */
export function resolveRecordSourceMatch(batch: ImportBatch, recordId: string, sameEvent: boolean): ImportBatch {
  return mapRecord(batch, recordId, (record) => {
    const withoutHold = record.errors.filter((item) => !item.startsWith("Looks like "));
    if (sameEvent) {
      const target = record.relationships.sourceMatchCommitmentId;
      if (!target) return record;
      // Same event on a source whose values differ from the plan's asks per field before it links.
      return enterLinkConflict({ ...record, operation: "link" as const, matchedEntityId: target, errors: withoutHold });
    }
    // Keep both restores the remote's own values wherever a choice had swapped in the plan's.
    const restored = { ...record.fields };
    for (const name of String(record.relationships.sourceMatchDiffFields ?? "")
      .split("|")
      .filter(Boolean)) {
      const remote = record.relationships[`sourceMatchRemote:${name}`];
      if (remote) restored[name] = userField(JSON.parse(remote) === null ? "" : String(JSON.parse(remote)), name);
    }
    return {
      ...record,
      fields: restored,
      operation: "create" as const,
      matchedEntityId: null,
      relationships: Object.fromEntries(
        Object.entries(record.relationships).filter(([name]) => !isSourceMatchRelationship(name))
      ),
      errors: withoutHold.filter((item) => !item.includes(" differs from the plan: ")),
      warnings: record.warnings.filter((item) => !item.startsWith("Already on your plan as "))
    };
  });
}

/**
 * "Remove it" on an event gone from one source but still held by others: the row was an `unlink`
 * (Keep, the default, drops only that source's link); this turns it into the delete of the commitment.
 */
export function dropRecordCommitment(batch: ImportBatch, recordId: string): ImportBatch {
  return mapRecord(batch, recordId, (record) => {
    const { sourceUnlinkLinkId: linkId, sourceUnlinkOthers: _others, ...relationships } = record.relationships;
    return {
      ...record,
      operation: "delete" as const,
      // The link stays named so the commit can remember that this source's removal was applied.
      relationships: { ...relationships, ...(linkId ? { sourceLinkId: linkId } : {}) },
      warnings: ["Confirming this row cancels the commitment. You can restore it from Review > Closed."]
    };
  });
}
