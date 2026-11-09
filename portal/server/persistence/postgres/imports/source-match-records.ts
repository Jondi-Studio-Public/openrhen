import { enterLinkConflict, withPlanValues } from "@/features/imports/source-match-conflicts";
import { extensionSentenceLabel } from "./import-extensions";
import { isPrimarySource, primarySourceLabel, PRIMARY_OWNED_FIELDS } from "./primary-source";
import "./private/index";
import {
  PARTS_LOCALE,
  carriesPublishMarker,
  commitmentRepeatFallsOn,
  matchCommitment,
  matchSeriesToRule,
  type CommitmentRepeat,
  type ImportRecord,
  type SourceAlias,
  type SourceCommitment,
  type SourceProvider,
  type SourceRule,
  sourceLabel
} from "@openrhen/contracts";
import { nextDayKey, zonedWallTimeOnDay } from "@/features/today/local-datetime";

/**
 * The pure half of cross-source matching inside an import diff (the source matching design note, "Flow
 * in a calendar import"): classify a remote event against the commitments already on the plan, and
 * reshape its create record into a `link` (Strong) or a held choice (Possible). The store loads the
 * context (`loadMatchContext`); nothing here touches a database.
 */

/** What the diff loads besides its own links: the window's commitments and the user's aliases. */
export interface SourceMatchContext {
  commitments: SourceCommitment[];
  aliases: SourceAlias[];
  /** Each commitment's place text (`SourceCommitment` carries none), by id, for comparing a joining source's. */
  locations?: Record<string, string | null> | undefined;
  /** Each commitment's version at load, so a link can refuse a commitment edited before commit. */
  versions?: Record<string, number> | undefined;
  /** The active repeating commitments over the window, so a whole remote series can link to one. */
  rules?: SourceRule[] | undefined;
}

/** One link on a commitment, as `loadCommitmentLinks` reads it: enough to unlink it or name its source. */
export interface CommitmentLink {
  id: string;
  provider: SourceProvider;
  externalEventId: string;
}

/** Every link of the commitments an updates diff touches, keyed by commitment id. */
export type CommitmentLinks = ReadonlyMap<string, readonly CommitmentLink[]>;

/** The fields a primary link gives, so a secondary source's change to them produces no row. */
export { PRIMARY_OWNED_FIELDS };

/** The fields a primary source owns on a commitment, when one of its links is among `others`. */
export function primaryOwnedFields(
  others: readonly CommitmentLink[]
): { fields: readonly string[]; owner: string } | null {
  const primary = others.find((other) => isPrimarySource(other.provider));
  return primary ? { fields: PRIMARY_OWNED_FIELDS, owner: primarySourceLabel(primary.provider) } : null;
}

/** YYYY-MM-DD of an instant in `timezone`. */
export function localDateIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(instant);
}

/** Sentence forms for the core source and any an import extension gives; every other id reads as `sourceLabel` gives it. */
const SENTENCE_LABEL: Record<string, string> = { email: "email" };

export function providerLabel(provider: SourceProvider): string {
  return (
    (Object.hasOwn(SENTENCE_LABEL, provider) ? SENTENCE_LABEL[provider] : extensionSentenceLabel(provider)) ??
    sourceLabel(provider)
  );
}

export interface SourceEventInput {
  provider: SourceProvider;
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  description?: string | null;
  timezone: string;
}

export type SourceClassification =
  | { kind: "skip" }
  | { kind: "none" }
  | {
      kind: "strong" | "possible";
      commitment: SourceCommitment;
      reason: string;
      planLocation: string | null;
      planVersion: number | null;
    };

/**
 * Where a remote event not yet linked by its own id stands. A `OpenRhen:<id>` marker means
 * OpenRhen wrote it, so it is skipped. Commitments already carrying a link from this provider are not
 * candidates (one link per provider per commitment), so a match there falls through to none.
 */
export function classifySourceEvent(
  event: SourceEventInput,
  context: SourceMatchContext | undefined
): SourceClassification {
  if (carriesPublishMarker(event.description ?? null)) return { kind: "skip" };
  if (!context) return { kind: "none" };
  const candidates = context.commitments.filter(
    (commitment) => !commitment.links.some((link) => link.provider === event.provider)
  );
  const match = matchCommitment(
    {
      provider: event.provider,
      externalId: event.externalId,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: false,
      localDate: localDateIn(new Date(event.startsAt), event.timezone),
      description: event.description ?? null
    },
    candidates,
    context.aliases
  );
  if (match.kind === "exact") return { kind: "skip" };
  if ((match.kind === "strong" || match.kind === "possible") && match.commitmentId) {
    const commitment = candidates.find((item) => item.id === match.commitmentId);
    // Several commitments fit equally: never an auto-link. `commitmentId` is the earliest of them, held as
    // a question ("Same event" / "Keep both") so the owner decides.
    if (commitment)
      return {
        kind: match.tie ? "possible" : match.kind,
        commitment,
        reason: match.tie ? "Two commitments fit equally" : match.reason,
        planLocation: context.locations?.[commitment.id] ?? null,
        planVersion: context.versions?.[commitment.id] ?? null
      };
  }
  return { kind: "none" };
}

/** Relationship names this feature owns; the review never offers them as text boxes. */
export const SOURCE_MATCH_PREFIX = "sourceMatch";

const clockTime = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat(PARTS_LOCALE, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));

/** "9:00–17:00" for a commitment, read in the batch's timezone. */
export function describeSpan(commitment: Pick<SourceCommitment, "startsAt" | "endsAt">, timezone: string): string {
  const start = clockTime(commitment.startsAt, timezone);
  return commitment.endsAt ? `${start}–${clockTime(commitment.endsAt, timezone)}` : start;
}

/**
 * Reshapes a create record into what a match calls for. Strong becomes a `link`, applied with the
 * batch. Possible becomes a held `conflict` whose two answers ("Same event", "Keep both") the review
 * resolves; nothing is preselected. Fields stay the remote's own so "Keep both" is the create it was.
 * `applyFields`, when given, names what a roster provider link writes onto the commitment at commit; every other
 * column is left as it stands (`maskToApplyFields`).
 */
export function toMatchRecord(
  record: ImportRecord,
  classification: Extract<SourceClassification, { kind: "strong" | "possible" }>,
  timezone: string,
  options: { provider: SourceProvider; applyFields?: readonly string[] }
): ImportRecord {
  const { commitment, reason } = classification;
  const applyFields = options.applyFields;
  const relationships = {
    ...record.relationships,
    [`${SOURCE_MATCH_PREFIX}Kind`]: classification.kind,
    [`${SOURCE_MATCH_PREFIX}CommitmentId`]: commitment.id,
    [`${SOURCE_MATCH_PREFIX}Title`]: commitment.title,
    [`${SOURCE_MATCH_PREFIX}Span`]: describeSpan(commitment, timezone),
    [`${SOURCE_MATCH_PREFIX}Reason`]: reason,
    [`${SOURCE_MATCH_PREFIX}RemoteLabel`]: providerLabel(options.provider),
    [`${SOURCE_MATCH_PREFIX}Timezone`]: timezone,
    ...(classification.planVersion === null
      ? {}
      : { [`${SOURCE_MATCH_PREFIX}Version`]: String(classification.planVersion) }),
    ...(applyFields ? { [`${SOURCE_MATCH_PREFIX}ApplyFields`]: applyFields.join("|") } : {})
  };
  const span = describeSpan(commitment, timezone);
  // A secondary source joining asks per field where its values differ from the plan's; a primary
  // source applies its own, and a secondary asks nothing about what a primary link on the commitment already gives.
  const primaryHeld = commitment.links.some((link) => isPrimarySource(link.provider));
  const withDiffs = (base: ImportRecord) =>
    applyFields
      ? base
      : withPlanValues(
          base,
          {
            title: commitment.title,
            startsAt: commitment.startsAt,
            endsAt: commitment.endsAt,
            location: classification.planLocation
          },
          primaryHeld ? PRIMARY_OWNED_FIELDS : []
        );
  if (classification.kind === "strong")
    return enterLinkConflict(
      withDiffs({
        ...record,
        operation: "link",
        matchedEntityId: commitment.id,
        relationships,
        warnings: [`Already on your plan as ${commitment.title}, ${span}: linked, not added again.`, ...record.warnings]
      })
    );
  return withDiffs({
    ...record,
    operation: "conflict",
    matchedEntityId: null,
    relationships,
    errors: [`Looks like ${commitment.title}, ${span} (${reason}). Choose Same event or Keep both.`]
  });
}

/** The record a roster provider link commits as an update: only `applyFields` are written, every other column absent. */
export function maskToApplyFields(record: ImportRecord, applyFields: readonly string[]): ImportRecord {
  return {
    ...record,
    fields: Object.fromEntries(
      Object.entries(record.fields).map(([name, field]) => [
        name,
        applyFields.includes(name) ? field : { ...field, source: "absent" as const }
      ])
    )
  };
}

/** A record proposing a new event: a create, or a match to a commitment already on the plan. */
export function isProposal(record: Pick<ImportRecord, "operation" | "relationships">): boolean {
  return (
    record.operation === "create" ||
    record.operation === "link" ||
    (record.operation === "conflict" && Boolean(record.relationships.sourceMatchKind))
  );
}

/** An active repeating commitment as `loadMatchContext` reads it, before its window is expanded. */
export interface RuleForMatching {
  id: string;
  title: string;
  version: number;
  timezone: string;
  startDate: string;
  endDate: string | null;
  repeat: CommitmentRepeat;
  localStartTime: string;
  localEndTime: string;
  linkedProviders: SourceProvider[];
}

/** A materialised occurrence of a rule: where it went, and whether it was cancelled. */
export interface RuleOccurrenceRow {
  ruleId: string;
  localDate: string;
  startsAt: string;
  endsAt: string | null;
  status: string;
}

/**
 * A rule's occurrences on each local day from `firstDay` to `lastDay` inclusive: the rule's own time on
 * every date it falls on, plus a materialised occurrence moved elsewhere. The rule's own time stands
 * even where that date's occurrence was cancelled or moved, because a series is compared with the
 * rule's pattern, not with this week's exceptions to it.
 */
export function expandRuleOccurrences(
  rule: RuleForMatching,
  materialised: readonly RuleOccurrenceRow[],
  firstDay: string,
  lastDay: string
): SourceRule {
  const occurrences: SourceCommitment[] = [];
  for (let day = firstDay; day <= lastDay; day = nextDayKey(day)) {
    if (day < rule.startDate || (rule.endDate && day > rule.endDate)) continue;
    if (!commitmentRepeatFallsOn(rule.repeat, rule.startDate, day)) continue;
    const startsAt = zonedWallTimeOnDay(day, rule.localStartTime, rule.timezone);
    let endsAt = zonedWallTimeOnDay(day, rule.localEndTime, rule.timezone);
    if (endsAt <= startsAt) endsAt = zonedWallTimeOnDay(nextDayKey(day), rule.localEndTime, rule.timezone);
    const base = { title: rule.title, allDay: false, localDate: day, status: "confirmed", links: [] };
    occurrences.push({
      ...base,
      id: `${rule.id}@${day}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString()
    });
    const moved = materialised.find(
      (row) =>
        row.ruleId === rule.id &&
        row.localDate === day &&
        row.status !== "cancelled" &&
        Date.parse(row.startsAt) !== startsAt.getTime()
    );
    if (moved)
      occurrences.push({ ...base, id: `${rule.id}@${day}:moved`, startsAt: moved.startsAt, endsAt: moved.endsAt });
  }
  return { id: rule.id, title: rule.title, version: rule.version, linkedProviders: rule.linkedProviders, occurrences };
}

export type SeriesClassification =
  { kind: "link"; rule: SourceRule; reason: string } | { kind: "occurrences" } | { kind: "series" };

/**
 * What a remote series grouped for import becomes. All of its
 * occurrences Strong-matching one rule's is a single link to that rule. Some, but not all, of them
 * Strong-matching something already on the plan is a partial agreement, so it falls back to one row per
 * occurrence, each matched on its own. Otherwise it is the new series it always was: an occurrence that
 * only resembles something (Possible) does not break a series into one-offs.
 */
export function classifySeries(
  events: readonly SourceEventInput[],
  context: SourceMatchContext | undefined
): SeriesClassification {
  if (!context) return { kind: "series" };
  const candidates = events.map((event) => ({
    provider: event.provider,
    externalId: event.externalId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: false,
    localDate: localDateIn(new Date(event.startsAt), event.timezone),
    description: event.description ?? null
  }));
  const rules = context.rules ?? [];
  const match = matchSeriesToRule(candidates, rules, context.aliases);
  const rule = match ? rules.find((item) => item.id === match.ruleId) : undefined;
  if (match && rule) return { kind: "link", rule, reason: match.reason };
  const partly = events.some((event) => classifySourceEvent(event, context).kind === "strong");
  return partly ? { kind: "occurrences" } : { kind: "series" };
}

/**
 * Reshapes a series create record into "Link series to *rule*": applied with the batch like a Strong
 * one-off link, and undone by **Keep both**, which puts the create back. The target rides the same
 * `sourceMatchCommitmentId` relationship a one-off link uses, so the review's answers apply unchanged;
 * `sourceMatchTarget` says it names a rule. A series link compares no field values: every occurrence
 * already agreed on time and title to be Strong.
 */
export function toSeriesLinkRecord(
  record: ImportRecord,
  classification: Extract<SeriesClassification, { kind: "link" }>,
  timezone: string,
  options: { provider: SourceProvider }
): ImportRecord {
  const { rule, reason } = classification;
  const first = rule.occurrences[0];
  const span = first ? describeSpan(first, timezone) : "";
  return {
    ...record,
    operation: "link",
    matchedEntityId: rule.id,
    relationships: {
      ...record.relationships,
      [`${SOURCE_MATCH_PREFIX}Kind`]: "strong",
      [`${SOURCE_MATCH_PREFIX}Target`]: "rule",
      [`${SOURCE_MATCH_PREFIX}CommitmentId`]: rule.id,
      [`${SOURCE_MATCH_PREFIX}Title`]: rule.title,
      [`${SOURCE_MATCH_PREFIX}Span`]: span,
      [`${SOURCE_MATCH_PREFIX}Reason`]: reason,
      [`${SOURCE_MATCH_PREFIX}RemoteLabel`]: providerLabel(options.provider),
      [`${SOURCE_MATCH_PREFIX}Timezone`]: timezone,
      [`${SOURCE_MATCH_PREFIX}Version`]: String(rule.version)
    },
    warnings: [
      `Already on your plan as the repeating ${rule.title}, ${span}: the series is linked, not added again.`,
      ...record.warnings
    ]
  };
}
