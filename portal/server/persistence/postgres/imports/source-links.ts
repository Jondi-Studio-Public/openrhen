import { aliasTitleNorm, sourceRole } from "@openrhen/contracts";
import type { SourceAlias, SourceCommitment, SourceProvider, SourceRule } from "@openrhen/contracts";
import { repeatOf } from "@/server/imports/rule-repeat";
import type { Sql } from "../sql-pool";
import { expandRuleOccurrences, localDateIn, type CommitmentLink } from "./source-match-records";

/**
 * The write and read helpers cross-source matching needs inside an import batch's transaction
 * link a source's event to an existing
 * commitment, drop one link, remember a "Same event" alias, and load the commitments and aliases a
 * diff matches against. Every function takes the batch's own handle so its writes commit or roll back
 * with the batch.
 */

export interface LinkSourceArgs {
  userId: string;
  provider: SourceProvider;
  frameId: string;
  externalEventId: string;
  commitmentId: string;
  profileLabel: string;
  sourceCalendarId?: string | null;
  /** What the remote said, kept so the next diff compares against this link's own last value. */
  snapshot: unknown;
  hash: string;
}

/**
 * Links one source's event to a commitment, with the provider's role. Re-linking the same external
 * event refreshes its snapshot as the per-provider inserts do. A second primary link to one commitment
 * (only possible for a second the roster provider link) throws: two definitive sources for one event is a data problem
 * to surface, not to choose between.
 */
export async function linkSourceToCommitment(sql: Sql, args: LinkSourceArgs): Promise<void> {
  const role = sourceRole(args.provider);
  if (role === "primary") {
    const other = await sql<{ id: string }[]>`
      SELECT id FROM calendar_event_links
      WHERE user_id=${args.userId} AND commitment_id=${args.commitmentId} AND role='primary'
        AND NOT (provider=${args.provider} AND frame_id=${args.frameId} AND external_event_id=${args.externalEventId})
      LIMIT 1
    `;
    if (other.length > 0) {
      throw new Error(`Commitment ${args.commitmentId} already has a primary source link; refusing a second`);
    }
  }
  await sql`
    INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,commitment_id,profile_label,source_calendar_id,last_remote_snapshot,last_remote_hash,last_seen_at)
    VALUES(${args.userId},${args.provider},${role},${args.frameId},${args.externalEventId},${args.commitmentId},${args.profileLabel},${args.sourceCalendarId ?? null},${sql.json(args.snapshot as never)},${args.hash},CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,provider,frame_id,external_event_id) DO UPDATE SET commitment_id=EXCLUDED.commitment_id,profile_label=EXCLUDED.profile_label,source_calendar_id=EXCLUDED.source_calendar_id,last_remote_snapshot=EXCLUDED.last_remote_snapshot,last_remote_hash=EXCLUDED.last_remote_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
  `;
}

/**
 * Links a source's whole series to a repeating commitment:
 * one row carrying `recurrence_rule_id`, keyed by `series:<id>` so it never collides with one of the
 * series' own events. The rule is left as it is, as a secondary link leaves a commitment.
 */
export async function linkSourceToRule(
  sql: Sql,
  args: Omit<LinkSourceArgs, "commitmentId"> & { ruleId: string }
): Promise<void> {
  await sql`
    INSERT INTO calendar_event_links(user_id,provider,role,frame_id,external_event_id,recurrence_rule_id,profile_label,source_calendar_id,last_remote_snapshot,last_remote_hash,last_seen_at)
    VALUES(${args.userId},${args.provider},${sourceRole(args.provider)},${args.frameId},${args.externalEventId},${args.ruleId},${args.profileLabel},${args.sourceCalendarId ?? null},${sql.json(args.snapshot as never)},${args.hash},CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,provider,frame_id,external_event_id) DO UPDATE SET recurrence_rule_id=EXCLUDED.recurrence_rule_id,commitment_id=NULL,profile_label=EXCLUDED.profile_label,source_calendar_id=EXCLUDED.source_calendar_id,last_remote_snapshot=EXCLUDED.last_remote_snapshot,last_remote_hash=EXCLUDED.last_remote_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
  `;
}

/** Removes exactly one link. The commitment and its other links are untouched. */
export async function unlinkSource(sql: Sql, args: { userId: string; linkId: string }): Promise<void> {
  await sql`DELETE FROM calendar_event_links WHERE user_id=${args.userId} AND id=${args.linkId}`;
}

/** Remembers that a remote title and a local title name the same event; recording it twice is a no-op. */
export async function recordSourceAlias(
  sql: Sql,
  args: { userId: string; provider: SourceProvider; remoteTitle: string; localTitle: string }
): Promise<void> {
  await sql`
    INSERT INTO source_match_aliases(user_id,provider,remote_title_norm,local_title_norm)
    VALUES(${args.userId},${args.provider},${aliasTitleNorm(args.remoteTitle)},${aliasTitleNorm(args.localTitle)})
    ON CONFLICT(user_id,provider,remote_title_norm,local_title_norm) DO NOTHING
  `;
}

interface CommitmentRow {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date | null;
  status: string;
  version: number;
  location: string | null;
  recurrence_rule_id: string | null;
  local_date: string | null;
  links: { provider: SourceProvider; external_event_id: string }[] | null;
}

interface RuleRow {
  id: string;
  title: string;
  version: number;
  timezone: string;
  start_date: string;
  end_date: string | null;
  interval_unit: "days" | "weeks" | "months";
  interval_days: number | null;
  interval_weeks: number | null;
  weekdays: number[] | null;
  interval_months: number | null;
  month_anchor: string | null;
  local_start_time: string;
  local_end_time: string;
  linked_providers: SourceProvider[] | null;
}

/**
 * The non-cancelled commitments starting in [fromIso, toIso), each with its links, the user's aliases,
 * and the active repeating commitments expanded over the same days: everything `matchCommitment` and
 * `matchSeriesToRule` need, in three queries. `commitments` has no all-day notion, so `allDay` is
 * always false.
 */
export async function loadMatchContext(
  sql: Sql,
  args: { userId: string; fromIso: string; toIso: string; timezone: string }
): Promise<{
  commitments: SourceCommitment[];
  aliases: SourceAlias[];
  locations: Record<string, string | null>;
  versions: Record<string, number>;
  rules: SourceRule[];
}> {
  const rows = await sql<CommitmentRow[]>`
    SELECT fc.id, fc.title, fc.starts_at, fc.ends_at, fc.status, fc.version, fc.location, fc.recurrence_rule_id, fc.local_date::text AS local_date,
      COALESCE((SELECT json_agg(json_build_object('provider', l.provider, 'external_event_id', l.external_event_id) ORDER BY l.created_at)
                FROM calendar_event_links l WHERE l.user_id=fc.user_id AND l.commitment_id=fc.id), '[]'::json) AS links
    FROM commitments fc
    WHERE fc.user_id=${args.userId} AND fc.status <> 'cancelled'
      AND fc.starts_at >= ${new Date(args.fromIso)} AND fc.starts_at < ${new Date(args.toIso)}
    ORDER BY fc.starts_at, fc.id
  `;
  const aliasRows = await sql<
    { provider: SourceProvider; remote_title_norm: string; local_title_norm: string }[]
  >`SELECT provider, remote_title_norm, local_title_norm FROM source_match_aliases WHERE user_id=${args.userId}`;
  const ruleRows = await sql<RuleRow[]>`
    SELECT r.id, r.title, r.version, r.timezone, r.start_date::text AS start_date, r.end_date::text AS end_date,
      r.interval_unit, r.interval_days, r.interval_weeks, r.weekdays, r.interval_months, r.month_anchor,
      r.local_start_time, r.local_end_time,
      (SELECT array_agg(l.provider) FROM calendar_event_links l WHERE l.user_id=r.user_id AND l.recurrence_rule_id=r.id) AS linked_providers
    FROM commitment_recurrence_rules r
    WHERE r.user_id=${args.userId} AND r.status='active'
    ORDER BY r.created_at, r.id
  `;
  const firstDay = localDateIn(new Date(args.fromIso), args.timezone);
  const lastDay = localDateIn(new Date(args.toIso), args.timezone);
  const materialised = rows.flatMap((row) =>
    row.recurrence_rule_id && row.local_date
      ? [
          {
            ruleId: row.recurrence_rule_id,
            localDate: row.local_date,
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at ? row.ends_at.toISOString() : null,
            status: row.status
          }
        ]
      : []
  );
  const rules = ruleRows.flatMap((row) => {
    const repeat = repeatOf(row);
    return repeat
      ? [
          expandRuleOccurrences(
            {
              id: row.id,
              title: row.title,
              version: row.version,
              timezone: row.timezone,
              startDate: row.start_date,
              endDate: row.end_date,
              repeat,
              localStartTime: row.local_start_time,
              localEndTime: row.local_end_time,
              linkedProviders: row.linked_providers ?? []
            },
            materialised,
            firstDay,
            lastDay
          )
        ]
      : [];
  });
  return {
    rules,
    locations: Object.fromEntries(rows.map((row) => [row.id, row.location])),
    versions: Object.fromEntries(rows.map((row) => [row.id, row.version])),
    commitments: rows.map((row) => ({
      id: row.id,
      title: row.title,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at ? row.ends_at.toISOString() : null,
      allDay: false,
      localDate: localDateIn(row.starts_at, args.timezone),
      status: row.status,
      links: (row.links ?? []).map((link) => ({ provider: link.provider, externalId: link.external_event_id }))
    })),
    aliases: aliasRows.map((row) => ({
      provider: row.provider,
      remoteTitleNorm: row.remote_title_norm,
      localTitleNorm: row.local_title_norm
    }))
  };
}

/** Every link of the given commitments, keyed by commitment id: what an updates diff needs to see a commitment's other sources. */
export async function loadCommitmentLinks(
  sql: Sql,
  args: { userId: string; commitmentIds: readonly string[] }
): Promise<Map<string, CommitmentLink[]>> {
  const result = new Map<string, CommitmentLink[]>();
  if (!args.commitmentIds.length) return result;
  const rows = await sql<{ id: string; commitment_id: string; provider: SourceProvider; external_event_id: string }[]>`
    SELECT id, commitment_id, provider, external_event_id FROM calendar_event_links
    WHERE user_id=${args.userId} AND commitment_id IN ${sql([...new Set(args.commitmentIds)])}
    ORDER BY created_at
  `;
  for (const row of rows) {
    const list = result.get(row.commitment_id) ?? [];
    list.push({ id: row.id, provider: row.provider, externalEventId: row.external_event_id });
    result.set(row.commitment_id, list);
  }
  return result;
}

/** The window an import diff loads its match context over: the requested days, padded a day either side. */
export function matchWindow(dateStart: string, dateEnd: string): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(Date.parse(`${dateStart}T00:00:00Z`) - 86_400_000).toISOString(),
    toIso: new Date(Date.parse(`${dateEnd}T00:00:00Z`) + 2 * 86_400_000).toISOString()
  };
}
