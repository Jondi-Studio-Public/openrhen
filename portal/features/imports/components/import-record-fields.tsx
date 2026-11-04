"use client";

import { useState } from "react";
import { isoToLocalInput, localInputToIso } from "@/features/imports/datetime-input";
import {
  calendarConflictProvider,
  calendarProviderLabel,
  conflictedFields
} from "@/features/imports/calendar-conflict";
import type { ImportRecord } from "@openrhen/contracts";
import { Field } from "@/components/field";
import { importBasisHint, importBasisLabel, importFieldLabel } from "@/features/imports/import-field-labels";
import { displayFieldValue, importDefault } from "@/features/imports/import-field-values";
import { importRecordWeekday, isImportWeekdayField } from "@/features/imports/import-record-weekday";
import { importFieldRelation, importFieldSpec, type ImportColumnSpec } from "@/features/imports/import-spec";
import type { CreatePlaceOptions } from "@/features/locations/create-place";
import type { GeocodeMatch } from "@/features/today/components/location-picker";
import { ContextChoices } from "./context-choices";
import { ImportLocationPickerSheet } from "./import-location-picker-sheet";
import { localiseIsoText } from "@/shared/date-format";
import type { PortalState } from "@/state/portal-state";

/**
 * Every field carries where its value came from, because a review is only meaningful if the reader
 * can tell an explicit value from one the extraction guessed. What each field offers to edit comes
 * from its column spec: an enum is a choice, a boolean a yes/no, a list of contexts a set to tick,
 * long text a textarea — and a commitment’s location can pull a saved place with it.
 *
 * The field a record is dated by also says which day that is, beside the box being typed into, since
 * a date is checked against a week rather than against a number.
 */
export function ImportRecordFields({
  record,
  conditionCatalog,
  places,
  timezone,
  updateField,
  applyLocation,
  createCustomLocation,
  resolveCalendarConflict,
  applyDefault
}: {
  record: ImportRecord;
  conditionCatalog: string[];
  places: PortalState["conditionDefinitions"];
  /** The batch's zone, in which an instant's day is read. */
  timezone?: string | undefined;
  updateField: (id: string, name: string, value: string) => void;
  applyLocation: (id: string, value: string) => void;
  createCustomLocation: (id: string, match: GeocodeMatch, options: CreatePlaceOptions) => Promise<void>;
  resolveCalendarConflict: (id: string, name: string, useRemote: boolean) => void;
  applyDefault: (id: string, name: string) => void;
}) {
  const conflictFields = conflictedFields(record);
  const conflictProvider = calendarConflictProvider(record);
  const remoteLabel =
    record.relationships.sourceMatchRemoteLabel ??
    (conflictProvider ? calendarProviderLabel(conflictProvider) : undefined) ??
    "the calendar";
  const disabled =
    record.removed || record.operation === "delete" || record.operation === "link" || record.operation === "unlink";
  const weekday = importRecordWeekday(record, timezone);
  // Instants are read in the batch's zone, or the reader's own when the batch has none.
  const readingZone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="import-fields">
      {Object.entries(record.fields).map(([name, field]) => {
        const column = importFieldSpec(record.entityType, name);
        return (
          <Field
            key={name}
            group={column?.kind === "list" && (column.conditionList || Boolean(column.enum))}
            label={
              <>
                {importFieldLabel(name)} <small title={importBasisHint(field)}>{importBasisLabel(field)}</small>
              </>
            }
          >
            <ImportFieldInput
              record={record}
              name={name}
              value={field.value}
              column={column}
              disabled={disabled}
              conditionCatalog={conditionCatalog}
              places={places}
              updateField={updateField}
              applyLocation={applyLocation}
              createCustomLocation={createCustomLocation}
              timeZone={readingZone}
            />
            {weekday && isImportWeekdayField(record.entityType, name) && (
              <small className="import-field-weekday">{weekday}</small>
            )}
            {conflictFields.includes(name) && (
              <span className="actions">
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => resolveCalendarConflict(record.id, name, false)}
                >
                  Keep OpenRhen
                </button>
                <button type="button" className="small" onClick={() => resolveCalendarConflict(record.id, name, true)}>
                  Use {remoteLabel}
                </button>
              </span>
            )}
            {field.value === null && importDefault(record.entityType, name) !== undefined && (
              <button type="button" className="quiet small" onClick={() => applyDefault(record.id, name)}>
                Apply default
              </button>
            )}
            {field.evidence.length ? (
              <small>Source: {localiseIsoText(field.evidence.join(" · "), readingZone)}</small>
            ) : null}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * The one input a field's kind asks for, shared by the card and by a table cell. `compact` is the
 * table's reading of the same kinds: a cell has one line to give, so long text becomes a two-row box
 * rather than a disclosure, and a list of contexts becomes a `|`-separated box with the catalogue
 * offered beside it rather than a column of tickboxes. What is written is identical either way —
 * `updateField` reads the text through `userField`, so a cell edited here is a cell the user filled.
 */
export function ImportFieldInput({
  record,
  name,
  value,
  column,
  disabled,
  compact,
  conditionCatalog,
  places,
  updateField,
  applyLocation,
  createCustomLocation,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: {
  record: ImportRecord;
  name: string;
  value: unknown;
  column: ImportColumnSpec | undefined;
  disabled: boolean;
  compact?: boolean;
  conditionCatalog: string[];
  places: PortalState["conditionDefinitions"];
  updateField: (id: string, name: string, value: string) => void;
  applyLocation: (id: string, value: string) => void;
  createCustomLocation: (id: string, match: GeocodeMatch, options: CreatePlaceOptions) => Promise<void>;
  /** The zone a datetime field is shown and edited in. */
  timeZone?: string | undefined;
}) {
  // Declared unconditionally, ahead of every branch below, because a field can return before
  // reaching the one branch (a saved-place key) that actually opens this popup.
  const [pickingLocation, setPickingLocation] = useState(false);
  const text = displayFieldValue(value, column?.kind);
  const onChange = (next: string) => updateField(record.id, name, next);
  // In a card the `<Field>` label names the input. In a table cell nothing does, so the column header
  // names it — the same word the reader typed under in the file.
  const label = compact ? (column?.header ?? name) : undefined;
  if (column?.multiline && !compact)
    return (
      <details className="notes-picker">
        <summary>{value ? "Details entered" : "Add details"}</summary>
        <textarea rows={3} disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} />
      </details>
    );
  if (column?.multiline)
    return (
      <textarea
        aria-label={label}
        rows={2}
        disabled={disabled}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (column?.kind === "list" && (column.conditionList || column.enum)) {
    const options = column.conditionList ? conditionCatalog : [...(column.enum ?? [])];
    if (!compact)
      return (
        <ContextChoices
          options={options}
          selected={Array.isArray(value) ? value.map(String) : []}
          disabled={disabled}
          onChange={(items) => onChange(items.join("|"))}
        />
      );
    const listId = `${record.id}-${name}-options`;
    return (
      <>
        <input
          aria-label={label}
          list={listId}
          placeholder="one|two"
          disabled={disabled}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={listId}>
          {options.map((option) => (
            <option value={option} key={option} />
          ))}
        </datalist>
      </>
    );
  }
  // A key that names a saved place is chosen from the catalogue rather than typed: the value stored
  // is a context id, which nobody should have to remember. A value the catalogue no longer offers —
  // an archived place, a key from another user's sheet — is kept as an option so it stays visible.
  const placeRelation = importFieldRelation(record.entityType, name);
  if (placeRelation?.targetConditionKind === "location") {
    const offered = places.filter((item) => item.kind === "location" && item.status === "active" && !item.oneOff);
    return (
      <>
        <span className="import-location-field">
          <select
            aria-label={label}
            disabled={disabled}
            value={text}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">—</option>
            {offered.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            {text && !offered.some((item) => item.id === text) ? <option value={text}>{text}</option> : null}
          </select>
          <button type="button" className="quiet small" disabled={disabled} onClick={() => setPickingLocation(true)}>
            Custom location…
          </button>
        </span>
        <ImportLocationPickerSheet
          open={pickingLocation}
          onClose={() => setPickingLocation(false)}
          onCreate={(match, options) => createCustomLocation(record.id, match, options)}
        />
      </>
    );
  }
  if (
    name === "location" &&
    (record.entityType === "fixed_commitment" || record.entityType === "fixed_commitment_recurrence")
  )
    return (
      <>
        <input
          aria-label={label}
          list="saved-import-locations"
          disabled={disabled}
          value={text}
          onChange={(event) => applyLocation(record.id, event.target.value)}
        />
        <datalist id="saved-import-locations">
          {places
            .filter((item) => item.status === "active" && !item.oneOff)
            .map((item) => (
              <option value={item.name} key={item.id} />
            ))}
        </datalist>
      </>
    );
  // A blank option keeps "clear this cell" possible: an enum or boolean left blank is a missing
  // field, not a value, and the review must be able to say so.
  if (column?.kind === "enum" || column?.kind === "boolean") {
    const choices = column.kind === "boolean" ? ["true", "false"] : (column.enum ?? []);
    return (
      <select aria-label={label} disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)}>
        <option value="">—</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
        {text && !choices.includes(text) ? <option value={text}>{text}</option> : null}
      </select>
    );
  }
  // A datetime reads as a date and time picker in the reading zone, not ISO text. Text that is not a
  // datetime yet stays a plain box, so the reader can see and fix what the file said.
  const local = column?.kind === "datetime" ? (text ? isoToLocalInput(text, timeZone) : "") : null;
  if (local !== null)
    return (
      <input
        type="datetime-local"
        aria-label={label}
        disabled={disabled}
        value={local}
        onChange={(event) => onChange(localInputToIso(event.target.value, timeZone) ?? "")}
      />
    );
  return (
    <input
      aria-label={label}
      inputMode={column?.kind === "number" ? "decimal" : undefined}
      placeholder={placeholderFor(column)}
      disabled={disabled}
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function placeholderFor(column: ImportColumnSpec | undefined): string | undefined {
  switch (column?.kind) {
    case "date":
      return "YYYY-MM-DD";
    case "datetime":
      return "2026-08-20T17:00:00+10:00";
    case "time":
      return "HH:MM";
    case "list":
      return "one|two";
    case "weekdays":
      return "Tue, Thu";
    case "pathwayGroups":
    case "requirementPathways":
      return "desktop+online | campus";
    default:
      return undefined;
  }
}
