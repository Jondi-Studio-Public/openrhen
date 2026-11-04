import { dateTimeFormat } from "@/shared/locale";
import { DEFAULT_TIMEZONE, PARTS_LOCALE } from "@openrhen/contracts";
import type { ImportField, ImportRecord } from "@openrhen/contracts";

/**
 * A secondary source joining a commitment the plan already holds (the source matching design note, "Which
 * source wins"): where the remote's title, start, end or place differ from the plan's, the row asks per
 * field, nothing preselected, in the same Keep OpenRhen / Use <source> choice a calendar conflict has.
 * Shared by the server diffs (a Strong match) and the review edit (a Possible match answered Same event).
 */

/** The fields a link compares; a primary source (the roster provider) owns all four, so a secondary asks about none while the roster provider is linked. */
export const LINK_COMPARED_FIELDS = ["title", "startsAt", "endsAt", "location"] as const;

/** What the plan holds for the matched commitment. */
export interface PlanValues {
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
}

const TIME_FIELDS = new Set(["startsAt", "endsAt"]);

function differs(name: string, remote: unknown, plan: unknown): boolean {
  if (TIME_FIELDS.has(name)) {
    if (remote === null || remote === undefined || plan === null || plan === undefined) return false;
    return Date.parse(String(remote)) !== Date.parse(String(plan));
  }
  const remoteText = String(remote ?? "").trim();
  const planText = String(plan ?? "").trim();
  // A remote with no place says nothing about it, so it never disagrees with a place the plan has.
  if (name === "location") return remoteText !== "" && remoteText.toLowerCase() !== planText.toLowerCase();
  return remoteText !== planText;
}

/** The compared fields, minus `skip`, whose remote value differs from the plan's. */
export function differingFields(
  remote: Record<string, ImportField>,
  plan: PlanValues,
  skip: readonly string[] = []
): string[] {
  return LINK_COMPARED_FIELDS.filter(
    (name) => !skip.includes(name) && name in remote && differs(name, remote[name]!.value, plan[name])
  );
}

/** A value as the disagreement message reads it: a time as the wall clock in the batch's zone. */
export function describeValue(name: string, value: unknown, timezone: string): string {
  if (value === null || value === undefined || value === "") return "nothing";
  if (TIME_FIELDS.has(name)) {
    return dateTimeFormat(PARTS_LOCALE, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(String(value)));
  }
  return String(value);
}

const asField = (value: unknown): ImportField =>
  value === null || value === undefined
    ? { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false }
    : { value, basis: "explicit", confidence: "high", evidence: [], needsReview: false, source: "cell" };

/**
 * Remembers, on a match record, what the plan holds for each differing field (and the remote's own value,
 * which the snapshot must keep however the choice goes). A record with no differing field is returned
 * unchanged, so it stays a plain link.
 */
export function withPlanValues(record: ImportRecord, plan: PlanValues, skip: readonly string[] = []): ImportRecord {
  const diffs = differingFields(record.fields, plan, skip);
  if (!diffs.length) return record;
  const relationships: Record<string, string | null> = {
    ...record.relationships,
    sourceMatchDiffFields: diffs.join("|")
  };
  for (const name of diffs) {
    relationships[`sourceMatchPlan:${name}`] = JSON.stringify(plan[name as keyof PlanValues]);
    relationships[`sourceMatchRemote:${name}`] = JSON.stringify(record.fields[name]!.value);
  }
  return { ...record, relationships };
}

/**
 * Turns a link with remembered differences into the held per-field choice: each differing field shows the
 * plan's value (Keep OpenRhen) with the remote's offered as Use <source>; nothing is preselected.
 */
export function enterLinkConflict(record: ImportRecord): ImportRecord {
  const diffs = String(record.relationships.sourceMatchDiffFields ?? "")
    .split("|")
    .filter(Boolean);
  if (!diffs.length) return record;
  const label = record.relationships.sourceMatchRemoteLabel ?? "The source";
  const timezone = record.relationships.sourceMatchTimezone ?? DEFAULT_TIMEZONE;
  const fields = { ...record.fields };
  const errors: string[] = [];
  for (const name of diffs) {
    const plan = JSON.parse(record.relationships[`sourceMatchPlan:${name}`] ?? "null");
    const remote = JSON.parse(record.relationships[`sourceMatchRemote:${name}`] ?? "null");
    fields[name] = asField(plan);
    errors.push(
      `${name} differs from the plan: ${label} says ${describeValue(name, remote, timezone)}, plan has ${describeValue(name, plan, timezone)}. Choose which value to keep.`
    );
  }
  return {
    ...record,
    operation: "conflict",
    fields,
    relationships: { ...record.relationships, sourceMatchConflictFields: diffs.join("|") },
    errors: [...record.errors.filter((item) => !item.includes(" differs from the plan: ")), ...errors]
  };
}
