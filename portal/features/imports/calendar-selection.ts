import { calendarSourceConnections, relationshipPrefixOf, type ImportRecord } from "@openrhen/contracts";

/** The import-key prefixes of a calendar source's records: one-off events and series, and a roster source's shifts. */
function recordKeyPrefixes(id: string): string[] {
  return [`${id}:event:`, `${id}:series:`, `${id}:shift:`];
}

export function isCalendarImportRecord(record: ImportRecord) {
  const sources = calendarSourceConnections();
  return (
    (record.entityType === "fixed_commitment" || record.entityType === "fixed_commitment_recurrence") &&
    (sources.some((source) => recordKeyPrefixes(source.id).some((prefix) => record.importKey.startsWith(prefix))) ||
      Object.keys(record.relationships).some((name) =>
        sources.some((source) => name.startsWith(relationshipPrefixOf(source)))
      ))
  );
}

export function setCalendarRecordsSelected(records: ImportRecord[], selected: boolean) {
  return records.map((record) => (isCalendarImportRecord(record) ? { ...record, removed: !selected } : record));
}
