import {
  calendarSinkConnection,
  calendarSourceConnections,
  relationshipPrefixOf,
  type ImportRecord
} from "@openrhen/contracts";

/**
 * Calendar providers hand a conflicted update to the review
 * with the same shape: `<provider>ConflictFields` names the fields changed on both sides and
 * `<provider>Remote:<field>` carries the remote value for each. This is the one place that knows the
 * prefix, so the review screen can offer "Use <provider>" from one code path.
 */
export type CalendarProvider = string;

/**
 * The registered calendar sources, each with the id its import keys start with, the prefix its conflict relationships
 * carry and the label the person knows it by. Most recently registered first, so the order of the checks below does
 * not depend on the core source that was always there.
 */
function calendarSources() {
  return [...calendarSourceConnections()].reverse().map((manifest) => ({
    keyPrefix: `${manifest.id}:`,
    provider: relationshipPrefixOf(manifest),
    label: manifest.label
  }));
}

export function calendarProviderLabel(provider: CalendarProvider): string | undefined {
  return calendarSources().find((source) => source.provider === provider)?.label;
}

export function calendarConflictProvider(
  record: Pick<ImportRecord, "importKey" | "relationships">
): CalendarProvider | null {
  const names = Object.keys(record.relationships);
  for (const source of calendarSources())
    if (record.importKey.startsWith(source.keyPrefix) || names.some((name) => name.startsWith(source.provider)))
      return source.provider;
  return null;
}

/** The provider a conflicted record is resolved against when its keys name none: the shared-calendar source, else the first source. */
export function defaultConflictProvider(): CalendarProvider {
  const manifest = calendarSinkConnection() ?? calendarSourceConnections()[0];
  return manifest ? relationshipPrefixOf(manifest) : "";
}

export function conflictFieldsKey(provider: CalendarProvider) {
  return `${provider}ConflictFields`;
}

export function remoteValueKey(provider: CalendarProvider, name: string) {
  return `${provider}Remote:${name}`;
}

/** The fields still waiting for a keep-or-take decision on a conflicted calendar record. */
export function conflictedFields(record: Pick<ImportRecord, "importKey" | "relationships">): string[] {
  // A source joining a commitment whose values differ (source-matching) names its own pending fields.
  if ("sourceMatchConflictFields" in record.relationships)
    return String(record.relationships.sourceMatchConflictFields ?? "")
      .split("|")
      .filter(Boolean);
  const provider = calendarConflictProvider(record);
  if (!provider) return [];
  return String(record.relationships[conflictFieldsKey(provider)] ?? "")
    .split("|")
    .filter(Boolean);
}

/** A relationship the provider owns for its own bookkeeping, never offered as an editable text box. */
export function isCalendarProviderRelationship(name: string) {
  // `feedSeries`, `feedDate`, `feedCancel`, ... are the calendar feed series pass's own markers on its records.
  return /^feed[A-Z]/.test(name) || calendarSources().some((source) => name.startsWith(source.provider));
}
