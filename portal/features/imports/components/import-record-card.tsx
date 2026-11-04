"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ImportEntityType, ImportRecord, TimeBand } from "@openrhen/contracts";
import { isCalendarProviderRelationship } from "@/features/imports/calendar-conflict";
import { describeImportRecordSource, isInternalRelationship } from "@/features/imports/import-record-source";
import { isHeldCancel } from "@/features/imports/import-batch-edits";
import { plainImportMessage } from "@/features/imports/import-field-labels";
import { importRecordWeekday } from "@/features/imports/import-record-weekday";
import { IMPORT_RELATION_TYPES } from "@/features/imports/import-spec";
import type { CreatePlaceOptions } from "@/features/locations/create-place";
import type { GeocodeMatch } from "@/features/today/components/location-picker";
import { ImportRecordFields } from "./import-record-fields";
import { ImportRecordRoutinePreview } from "./import-record-routine-preview";
import "@/features/imports/private/index";
import { holdManagedRelationshipKeys } from "@/features/imports/import-holds";
import { extensionRecordNotices } from "@/state/extensions";
import type { PortalState } from "@/state/portal-state";

/** Everything a record row can do to the batch, passed down rather than reached for. */
export interface ImportRecordActions {
  conditionCatalog: string[];
  places: PortalState["conditionDefinitions"];
  routinePresets: PortalState["routinePresets"];
  /** Preferred-time-bands choices offered on a one-off routine step's timing fields. */
  timeBands: TimeBand[];
  /**
   * The batch's own zone, so a calendar event's day is named where the event happens rather than
   * wherever the browser is. Optional: with none, an instant falls back to the reader's own zone.
   */
  timezone?: string | undefined;
  /** Import keys in the batch by entity type, offered as suggestions when a relationship key is typed. */
  batchKeys?: Partial<Record<ImportEntityType, string[]>>;
  updateField: (id: string, name: string, value: string) => void;
  applyLocation: (id: string, value: string) => void;
  /** Stores a geocoder match as a place — one-off or, named, permanent — and sets it on the record. */
  createCustomLocation: (id: string, match: GeocodeMatch, options: CreatePlaceOptions) => Promise<void>;
  selectRoutine: (id: string, value: string) => void;
  patchRoutineSteps: (id: string, steps: unknown[]) => void;
  updateRelationship: (id: string, name: string, value: string) => void;
  resolveCalendarConflict: (id: string, name: string, useRemote: boolean) => void;
  applyDefault: (id: string, name: string) => void;
  toggleRemoved: (id: string) => void;
  /** "Apply anyway" on a held overlap clash — see `acceptRecordOverlap`. */
  acceptOverlap: (id: string) => void;
  /** "Delete anyway" on a cancel of a commitment edited since — see `acceptRecordCancel`. */
  acceptCancel: (id: string) => void;
  /** "Same event" / "Keep both" on a row matched to a commitment already on the plan. */
  resolveSourceMatch: (id: string, sameEvent: boolean) => void;
  /** "Remove commitment too" on an event gone from one source but still held by others. */
  dropCommitment: (id: string) => void;
}

export interface ImportRecordCardProps extends ImportRecordActions {
  record: ImportRecord;
}

/** Relationships the screen manages itself, so they are never offered as raw text boxes. */
const managedRelationships = () => [
  ...holdManagedRelationshipKeys(),
  "locationProfileId",
  "routinePresetId",
  "routineSteps",
  "remoteCancelEdited",
  "remoteCancelled",
  "sourceLinkId",
  "sourceReopen",
  "sourceClear"
];
/** The source-matching relationships are the screen's own; the card explains them instead. */
const isSourceMatchRelationship = (name: string) => name.startsWith("sourceMatch") || name.startsWith("sourceUnlink");
const editableRelationships = (record: ImportRecord) =>
  Object.entries(record.relationships).filter(
    ([name]) =>
      !isCalendarProviderRelationship(name) &&
      !isInternalRelationship(name) &&
      !isSourceMatchRelationship(name) &&
      !managedRelationships().includes(name)
  );

export function ImportRecordCard({
  record,
  conditionCatalog,
  places,
  routinePresets,
  timezone,
  batchKeys,
  updateField,
  applyLocation,
  createCustomLocation,
  selectRoutine,
  patchRoutineSteps,
  updateRelationship,
  resolveCalendarConflict,
  applyDefault,
  toggleRemoved,
  acceptOverlap,
  acceptCancel,
  resolveSourceMatch,
  dropCommitment
}: ImportRecordCardProps) {
  const relationships = editableRelationships(record);
  // Linking, but the source's values differ from the plan's: the per-field choice below settles it.
  const sourceDisagrees = "sourceMatchConflictFields" in record.relationships;
  // Where the row came from, when a file produced it: an error here is only actionable if the reader
  // can find the row it belongs to in the spreadsheet they are looking at.
  const source = describeImportRecordSource(record);
  // The key a calendar hands over is a machine's name for the event, so the heading also says what
  // the record is called and, for a dated one, which day it falls on — read from the fields as they
  // stand, so editing the date renames the day with it.
  const title = String(record.fields.title?.value ?? "").trim();
  const weekday = importRecordWeekday(record, timezone);
  // Instants in a message are read in the batch's zone, or the reader's own when the batch has none.
  const readingZone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fieldNames = Object.keys(record.fields);
  const plain = (message: string) => plainImportMessage(message, fieldNames, readingZone);
  return (
    <article className={`import-record ${record.removed ? "removed" : ""}`}>
      <header>
        <div>
          <Badge tone={record.errors.length ? "neutral" : "accent"} dot={false}>
            {record.operation}
          </Badge>
          <strong>
            {record.entityType.replaceAll("_", " ")} · {record.importKey}
          </strong>
          {(title || weekday) && (
            <span className="import-record-headline">
              {title}
              {weekday && <small className="import-record-weekday">{weekday}</small>}
            </span>
          )}
          {source && <small className="import-record-source">{source}</small>}
        </div>
        <Button variant="secondary" size="sm" onClick={() => toggleRemoved(record.id)}>
          {record.removed ? "Restore" : "Remove"}
        </Button>
      </header>
      {record.errors.map((item) => (
        <p className="record-error" key={item}>
          {plain(item)}
        </p>
      ))}
      {record.warnings.map((item) => (
        <p className="record-warning" key={item}>
          {plain(item)}
        </p>
      ))}
      {/* Only unticking this row and committing the batch makes the feed remember Keep; discarding the whole batch does not. */}
      {record.relationships.feedReason && (
        <div className="import-record-feed-reason">
          <p className="record-warning">{record.relationships.feedReason}</p>
          <div className="overlap-actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => toggleRemoved(record.id)}>
              {record.removed ? "End it instead" : "Keep it"}
            </Button>
          </div>
        </div>
      )}
      {record.relationships.feedNote && <p className="record-warning">{record.relationships.feedNote}</p>}
      {extensionRecordNotices().map((Notice, index) => (
        <Notice
          key={index}
          record={record}
          weekday={weekday}
          readingZone={readingZone}
          acceptOverlap={acceptOverlap}
          toggleRemoved={toggleRemoved}
        />
      ))}
      {record.relationships.sourceMatchCommitmentId && record.operation !== "create" && (
        <div className="import-record-source-match">
          <p className={record.operation === "link" ? "record-warning" : "record-conflict"}>
            {record.relationships.sourceMatchTarget === "rule"
              ? "Link series to "
              : record.operation === "link" || sourceDisagrees
                ? "Link to "
                : "Looks like "}
            <strong>{record.relationships.sourceMatchTitle}</strong>, {record.relationships.sourceMatchSpan}
            {record.relationships.sourceMatchReason ? <small> · {record.relationships.sourceMatchReason}</small> : null}
          </p>
          <div className="overlap-actions">
            {record.operation !== "link" && !sourceDisagrees && (
              <Button type="button" variant="primary" size="sm" onClick={() => resolveSourceMatch(record.id, true)}>
                Same event
              </Button>
            )}
            <Button type="button" variant="secondary" size="sm" onClick={() => resolveSourceMatch(record.id, false)}>
              Keep both
            </Button>
          </div>
        </div>
      )}
      {record.operation === "unlink" && (
        <div className="overlap-actions">
          <span>Keep: only this source's link is dropped.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => dropCommitment(record.id)}>
            Remove commitment too
          </Button>
        </div>
      )}
      {isHeldCancel(record) && (
        <div className="overlap-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => acceptCancel(record.id)}>
            Delete anyway
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => toggleRemoved(record.id)}>
            Keep it
          </Button>
        </div>
      )}
      <ImportRecordFields
        record={record}
        conditionCatalog={conditionCatalog}
        places={places}
        timezone={timezone}
        updateField={updateField}
        applyLocation={applyLocation}
        createCustomLocation={createCustomLocation}
        resolveCalendarConflict={resolveCalendarConflict}
        applyDefault={applyDefault}
      />
      {record.entityType === "fixed_commitment" &&
        record.operation !== "delete" &&
        record.operation !== "link" &&
        record.operation !== "unlink" &&
        !isHeldCancel(record) && (
          <ImportRecordRoutinePreview
            record={record}
            conditionCatalog={conditionCatalog}
            routinePresets={routinePresets}
            selectRoutine={selectRoutine}
            patchRoutineSteps={patchRoutineSteps}
          />
        )}
      {relationships.length ? (
        <div className="import-fields relationships">
          {relationships.map(([name, value]) => {
            const targetType = IMPORT_RELATION_TYPES[name];
            const suggestions = targetType ? batchKeys?.[targetType] : undefined;
            const listId = suggestions ? `${record.id}-${name}-keys` : undefined;
            return (
              <label className="field" key={name}>
                <span>{name}</span>
                <input
                  list={listId}
                  disabled={record.removed}
                  value={value ?? ""}
                  onChange={(event) => updateRelationship(record.id, name, event.target.value)}
                />
                {suggestions ? (
                  <datalist id={listId}>
                    {suggestions
                      .filter((key) => key !== record.importKey || targetType !== record.entityType)
                      .map((key) => (
                        <option value={key} key={key} />
                      ))}
                  </datalist>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
