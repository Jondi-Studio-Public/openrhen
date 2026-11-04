import type { ImportRecord } from "@openrhen/contracts";
import type { Sql } from "../sql-pool";
import { recordCalendarDismissals } from "./calendar-diff-core";
import {
  CALENDAR_FEED_PROVIDER,
  FEED_EVENT_PREFIX,
  FEED_FRAME,
  FEED_SERIES_PREFIX,
  feedGenerationOfKey,
  type FeedSource
} from "./calendar-profiles/calendar-feed";
import { FEED_OCC_PREFIX, feedDateDismissalId, feedDateFingerprint } from "./calendar-feed-dates";
import {
  feedSeriesDismissalId,
  feedSeriesLinkId,
  ruleLinkEndedBy,
  ruleLinkIdentity,
  type FeedEndedBy,
  type FeedRuleLinkRow
} from "./calendar-feed-series";

/**
 * What the calendar feed remembers about a rule beyond its fields (build plan PR 9): who ended it, which end the owner
 * chose to keep, which dates the owner kept as they are, and the stale import keys an owner's deletion leaves behind.
 * All of it is bookkeeping on the feed's own rows (its links, its dismissals, its import keys), never the plan itself.
 * `repairStaleFeedKeys`, `settleRuleEnds` and `forgetKeptEnds` run at diff time; `recordFeedChoices` runs inside the
 * commit transaction (the extension's `afterCommit`).
 */

/** A link's snapshot with `fields` merged in (and `drop` removed), in one statement; nothing is written without the link. */
async function patchLinkSnapshot(
  sql: Sql,
  userId: string,
  where: { externalEventId: string } | { ruleId: string },
  patch: Record<string, unknown>,
  drop: readonly string[] = []
): Promise<void> {
  const body = sql.json(patch as never);
  const removed = sql.json([...drop] as never);
  const target =
    "externalEventId" in where
      ? sql`l.external_event_id=${where.externalEventId}`
      : sql`l.recurrence_rule_id=${where.ruleId}`;
  await sql`
    UPDATE calendar_event_links l SET
      last_remote_snapshot = (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
        FROM jsonb_each(l.last_remote_snapshot) AS e(key, value) WHERE NOT (${removed}::jsonb @> to_jsonb(e.key))) || ${body}::jsonb,
      updated_at = CURRENT_TIMESTAMP
    WHERE l.user_id=${userId} AND l.provider=${CALENDAR_FEED_PROVIDER} AND l.frame_id=${FEED_FRAME} AND ${target}
  `;
}

/**
 * Clears the import keys an owner's deletion leaves behind. Deleting a rule (or a moved meeting's replacement, or any
 * feed-made commitment) removes the row and its link but not its `import_entity_keys` entry, and the next proposal for the
 * same key then resolves as an update of something that no longer exists, a confusing conflict held every hour.
 *
 * A rule deleted outright is also a decision: the owner does not want that UID's entry back, so a decline (`series:<stem>`,
 * every generation) is written for each UID of the current read whose stem the dead key names. A dead key whose UID is
 * not in this read is only cleared (the UID cannot be named from the key alone: a stem may itself end in `.2`, and the
 * link that knew the stem went with the rule). Known limit: such a UID is proposed afresh if it returns. Closing it
 * would mean recording the stem somewhere that survives the rule's deletion (a table or a column), which is a migration.
 */
export async function repairStaleFeedKeys(sql: Sql, userId: string, readStems: Iterable<string>): Promise<void> {
  const deadRules = await sql<{ import_key: string }[]>`
    SELECT k.import_key FROM import_entity_keys k
    WHERE k.user_id=${userId} AND k.entity_type='fixed_commitment_recurrence' AND starts_with(k.import_key, ${FEED_SERIES_PREFIX})
      AND NOT EXISTS (SELECT 1 FROM commitment_recurrence_rules r WHERE r.id=k.entity_id AND r.user_id=${userId})
  `;
  if (deadRules.length) {
    const stems = [...new Set(readStems)];
    const declines = new Map<string, { externalEventId: string; title: string; startsAt: string }>();
    for (const { import_key: key } of deadRules)
      for (const stem of stems)
        if (feedGenerationOfKey(key, stem) !== null)
          declines.set(stem, {
            externalEventId: feedSeriesDismissalId(stem),
            title: "Deleted on the plan",
            startsAt: new Date().toISOString()
          });
    await recordCalendarDismissals(sql, userId, CALENDAR_FEED_PROVIDER, [...declines.values()]);
    await sql`
      DELETE FROM import_entity_keys k
      WHERE k.user_id=${userId} AND k.entity_type='fixed_commitment_recurrence' AND starts_with(k.import_key, ${FEED_SERIES_PREFIX})
        AND NOT EXISTS (SELECT 1 FROM commitment_recurrence_rules r WHERE r.id=k.entity_id AND r.user_id=${userId})
    `;
  }
  await sql`
    DELETE FROM import_entity_keys k
    WHERE k.user_id=${userId} AND k.entity_type='fixed_commitment'
      AND (starts_with(k.import_key, ${FEED_EVENT_PREFIX}) OR starts_with(k.import_key, ${FEED_OCC_PREFIX}))
      AND NOT EXISTS (SELECT 1 FROM commitments c WHERE c.id=k.entity_id AND c.user_id=${userId})
  `;
  // A kept date is remembered only while it can matter: one whose day has passed is forgotten.
  await sql`
    DELETE FROM calendar_event_dismissals
    WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER} AND starts_with(external_event_id, 'occ:') AND starts_at < CURRENT_TIMESTAMP - INTERVAL '2 days'
  `;
}

/**
 * Settles who ended each rule, from what the links say. An ended rule whose link records no end was ended by the owner
 * (the feed's own end commit and a shape approval record theirs): that is written down and the UID is declined, so a
 * rule the owner ended is never recreated, not even after the rule row is deleted. A rule that is active again (the
 * owner reopened it) forgets who ended it. Returns the links as they now stand.
 */
export async function settleRuleEnds(
  sql: Sql,
  userId: string,
  links: readonly FeedRuleLinkRow[]
): Promise<FeedRuleLinkRow[]> {
  const out: FeedRuleLinkRow[] = [];
  for (const link of links) {
    const identity = ruleLinkIdentity(link);
    if (!identity) {
      out.push(link);
      continue;
    }
    if (link.status !== "active" && ruleLinkEndedBy(link) === null) {
      await patchLinkSnapshot(sql, userId, { externalEventId: link.external_event_id }, { endedBy: "owner" }, [
        "feedKeep"
      ]);
      await recordCalendarDismissals(sql, userId, CALENDAR_FEED_PROVIDER, [
        { externalEventId: feedSeriesDismissalId(identity.stem), title: link.title, startsAt: new Date().toISOString() }
      ]);
      out.push({ ...link, last_remote_snapshot: { ...link.last_remote_snapshot, endedBy: "owner" } });
      continue;
    }
    if (link.status === "active" && ruleLinkEndedBy(link) !== null) {
      await patchLinkSnapshot(sql, userId, { externalEventId: link.external_event_id }, {}, ["endedBy"]);
      // The decline an owner's end wrote is the owner's to take back: reopening the rule withdraws it, so a later end by
      // the feed can still be revived. A shape end's decline stays (the owner approved that end on the card).
      if (ruleLinkEndedBy(link) === "owner")
        await sql`DELETE FROM calendar_event_dismissals WHERE user_id=${userId} AND provider=${CALENDAR_FEED_PROVIDER} AND external_event_id=${feedSeriesDismissalId(identity.stem)}`;
      const { endedBy: _gone, ...rest } = link.last_remote_snapshot ?? {};
      out.push({ ...link, last_remote_snapshot: rest });
      continue;
    }
    out.push(link);
  }
  return out;
}

/** Forgets the kept ends whose condition no longer holds (the feed changed it back); `externalEventIds` are the links. */
export async function forgetKeptEnds(sql: Sql, userId: string, externalEventIds: readonly string[]): Promise<void> {
  for (const externalEventId of new Set(externalEventIds))
    await patchLinkSnapshot(sql, userId, { externalEventId }, {}, ["feedKeep"]);
}

/**
 * Writes down what a committed batch decided, from the records the commit saw (inside its transaction):
 * - a held rule end that was committed: the rule is ended, and the link records by whom (`feed` for a cancelled or
 *   vanished UID, `shape` for a shape change the owner approved; the latter also declines the UID);
 * - a held rule end the owner unticked ("Keep"): the link records the kept kind, so the end is not proposed again;
 * - a held date record the owner unticked: the date is remembered with a fingerprint of what the feed asked, so the same
 *   ask is not made again (the batch's own descriptor supplies it, never the record).
 */
export async function recordFeedChoices(
  tx: Sql,
  userId: string,
  args: { records: readonly ImportRecord[]; ready: readonly ImportRecord[]; linkSource: unknown }
): Promise<void> {
  const source = args.linkSource as FeedSource | undefined;
  const readyIds = new Set(args.ready.map((record) => record.id));
  const kept: { externalEventId: string; title: string; startsAt: string }[] = [];
  for (const record of args.records) {
    const rel = record.relationships;
    const stem = rel.feedSeries;
    if (!stem) continue;
    if (record.entityType === "fixed_commitment_recurrence" && record.importKey.startsWith(FEED_SERIES_PREFIX)) {
      if (record.operation !== "delete") continue;
      const generation = feedGenerationOfKey(record.importKey, stem);
      const kind = rel.feedReasonKind;
      if (!generation || (kind !== "cancelled" && kind !== "gone" && kind !== "shape")) continue;
      const externalEventId = feedSeriesLinkId(stem, generation);
      if (readyIds.has(record.id)) {
        const endedBy: FeedEndedBy = kind === "shape" ? "shape" : "feed";
        await patchLinkSnapshot(tx, userId, { externalEventId }, { endedBy }, ["feedKeep"]);
        if (kind === "shape") {
          const title = String(record.fields.title?.value ?? stem);
          await recordCalendarDismissals(tx, userId, CALENDAR_FEED_PROVIDER, [
            { externalEventId: feedSeriesDismissalId(stem), title, startsAt: new Date().toISOString() }
          ]);
        }
      } else if (record.removed) {
        await patchLinkSnapshot(tx, userId, { externalEventId }, { feedKeep: kind });
      }
      continue;
    }
    if (record.entityType === "fixed_commitment" && record.importKey.startsWith(FEED_OCC_PREFIX) && record.removed) {
      const date = rel.feedDate;
      const ruleId = rel.feedRule;
      if (!date || !ruleId) continue;
      const exception = source?.series?.[stem]?.exceptions.find((candidate) => candidate.date === date);
      kept.push({
        externalEventId: feedDateDismissalId(ruleId, date),
        title: feedDateFingerprint(exception),
        startsAt: new Date(`${date}T00:00:00.000Z`).toISOString()
      });
    }
  }
  await recordCalendarDismissals(tx, userId, CALENDAR_FEED_PROVIDER, kept);
}
