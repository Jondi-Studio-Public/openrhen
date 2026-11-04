"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  DEFAULT_TIME_BANDS,
  type ImportBatch,
  type ImportRecord,
  type PlanningEntityCommand
} from "@openrhen/contracts";
import { isCalendarImportRecord } from "@/features/imports/calendar-selection";
import { activeConditionIds } from "@/features/settings/context-summary";
import {
  acceptRecordCancel,
  dropRecordCommitment,
  resolveRecordSourceMatch,
  acceptRecordOverlap,
  applyBlankDefaults,
  applyRecordDefault,
  applyRecordLocation,
  countBlockingImportRecords,
  filterImportRecords,
  importKeysByType,
  patchRecordRoutineSteps,
  removeBlockingRecords,
  resolveRecordSharedCalendarConflict,
  selectRecordRoutine,
  setCalendarSelection,
  toggleRecordRemoved,
  updateRecordField,
  updateRecordRelationship,
  type ImportRecordFilter
} from "@/features/imports/import-batch-edits";
import type { ImportRecordActions } from "@/features/imports/components/import-record-card";
import { createPlace, type CreatePlaceOptions } from "@/features/locations/create-place";
import type { GeocodeMatch } from "@/features/today/components/location-picker";
import type { PortalState } from "@/state/portal-state";

/**
 * The batch under review and every edit the review screen can make to it. Each edit is a pure
 * transform from `import-batch-edits` applied to the current batch; what the screen shows — the
 * filtered records, the blocker count, the calendar selection — is read from the batch each render.
 *
 * Because every transform revalidates in the browser, those counts answer for the batch as it now
 * stands rather than as the server last saw it. `pendingEdits` says the two have parted company, so
 * the screen can offer the newer count while still being plain that only a saved draft can commit.
 */
export function useImportReview(
  state: PortalState,
  batch: ImportBatch | null,
  setBatch: Dispatch<SetStateAction<ImportBatch | null>>,
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>
) {
  const [filter, setFilter] = useState<ImportRecordFilter>("all");
  const [pendingEdits, setPendingEdits] = useState(false);
  const records = batch?.records ?? [];
  const visible = useMemo(() => filterImportRecords(batch?.records ?? [], filter), [batch, filter]);
  const batchKeys = useMemo(() => importKeysByType(batch?.records ?? []), [batch]);
  const calendarRecords = records.filter(isCalendarImportRecord);
  const selectedCalendarRecords = calendarRecords.filter((record) => !record.removed);
  const blocking = countBlockingImportRecords(records);
  /** Kept records a partial commit would write now: everything kept that is not a blocker. */
  const ready = records.filter((record) => !record.removed).length - blocking;

  const edit = (change: (current: ImportBatch) => ImportBatch) => {
    setPendingEdits(true);
    setBatch((current) => (current ? change(current) : current));
  };

  const locationDefaults = {
    conditionDefinitions: state.conditionDefinitions,
    routinePresets: state.routinePresets,
    defaultSetupBufferMinutes: state.settings.defaultSetupBufferMinutes,
    defaultTransitionBufferMinutes: state.settings.defaultTransitionBufferMinutes
  };

  const recordActions: ImportRecordActions = {
    // the flat catalogue is retired; the picker now offers every active typed context's id.
    conditionCatalog: activeConditionIds(state.conditionDefinitions),
    places: state.conditionDefinitions.filter((item) => item.kind === "location"),
    routinePresets: state.routinePresets,
    timeBands: state.settings.timeBands ?? DEFAULT_TIME_BANDS,
    // The zone the batch was read under, so a dated record names the day it falls on there.
    timezone: batch?.timezone,
    batchKeys,
    updateField: (id: string, name: string, raw: string) =>
      edit((current) => updateRecordField(current, id, name, raw)),
    applyLocation: (id: string, value: string) =>
      edit((current) => applyRecordLocation(current, id, value, locationDefaults)),
    // A place picked from a geocoder match — one-off or, with a name, permanent — is created first
    // and then applied by its own id, since a place this fresh has not yet reached the local catalogue
    // for `applyLocation`'s name match to find.
    createCustomLocation: async (id: string, match: GeocodeMatch, options: CreatePlaceOptions) => {
      const place = await createPlace(match, saveEntityCommand, options);
      edit((current) => applyRecordLocation(current, id, place.name, locationDefaults, place.id));
    },
    selectRoutine: (id: string, presetId: string) =>
      edit((current) => selectRecordRoutine(current, id, presetId, state.routinePresets)),
    patchRoutineSteps: (id: string, steps: unknown[]) => edit((current) => patchRecordRoutineSteps(current, id, steps)),
    updateRelationship: (id: string, name: string, value: string) =>
      edit((current) => updateRecordRelationship(current, id, name, value)),
    resolveCalendarConflict: (id: string, name: string, useRemote: boolean) =>
      edit((current) => resolveRecordSharedCalendarConflict(current, id, name, useRemote)),
    applyDefault: (id: string, name: string) => edit((current) => applyRecordDefault(current, id, name)),
    toggleRemoved: (id: string) => edit((current) => toggleRecordRemoved(current, id)),
    acceptOverlap: (id: string) => edit((current) => acceptRecordOverlap(current, id)),
    acceptCancel: (id: string) => edit((current) => acceptRecordCancel(current, id)),
    resolveSourceMatch: (id: string, sameEvent: boolean) =>
      edit((current) => resolveRecordSourceMatch(current, id, sameEvent)),
    dropCommitment: (id: string) => edit((current) => dropRecordCommitment(current, id))
  };

  /** Puts the review away: no batch, no filter. What was unsaved is dropped. */
  function closeBatch() {
    setBatch(null);
    setFilter("all");
    setPendingEdits(false);
  }

  return {
    filter,
    setFilter,
    visible,
    blocking,
    ready,
    pendingEdits,
    /** A batch the server has just answered with is what it says it is again. */
    markSaved: () => setPendingEdits(false),
    calendarRecords,
    selectedCalendarRecords,
    setCalendarSelection: (selected: boolean) => edit((current) => setCalendarSelection(current, selected)),
    /**
     * Both bulk actions are told which records to touch rather than deciding for themselves, because
     * what is on screen is the review panel's answer: the filter narrows it, and a table's search
     * narrows it again. A button that names a count must act on exactly what it counted.
     */
    applyDefaultsIn: (records: ImportRecord[]) => edit((current) => applyBlankDefaults(current, records)),
    removeBlockersIn: (records: ImportRecord[]) => edit((current) => removeBlockingRecords(current, records)),
    recordActions,
    closeBatch
  };
}
