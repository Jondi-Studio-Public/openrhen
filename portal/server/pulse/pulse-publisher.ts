import {
  DEFAULT_TIMEZONE,
  publicPulse,
  publicPulseChangeKey,
  type PublicPulseV1,
  type PulsePublishResult
} from "@openrhen/contracts";
import { readPulseState } from "./pulse-read";
import { publishPulseViaProxy } from "./pulse-publish-client";
import type { PoolSql, Sql } from "../persistence/postgres/sql-pool";

/**
 * `portal/server/pulse/pulse-publisher.ts` (the pulse criteria and publish design note, "Shares and
 * the public object", "Publish"): after each recorder run, when the user has opted in, sends the
 * redacted public object through the outbound proxy whenever it actually changed, or every 15
 * minutes regardless (the heartbeat backstop). A failed send is never recorded as delivered, so the
 * very next tick retries it unconditionally — the heartbeat only governs *unchanged* content.
 */
const HEARTBEAT_MS = 15 * 60_000;

export type PulsePublisherOutcome =
  | { status: "sent"; outcome: PulsePublishResult["outcome"] }
  | { status: "skipped"; reason: "disabled" | "not_evaluated" | "unchanged" | "busy" };

interface PulseStateRow {
  // `bigint` columns come back from postgres.js as strings, not numbers (int8 can exceed what a JS
  // number represents exactly) — read through `Number(...)` below rather than trusting this type.
  publish_seq: number | string;
  last_published_hash: string | null;
  last_published_at: Date | null;
  last_publish_outcome: string | null;
  last_publish_error: string | null;
}

async function readPulseStateRow(sql: Sql, userId: string): Promise<PulseStateRow | undefined> {
  const rows = await sql<PulseStateRow[]>`
    SELECT publish_seq, last_published_hash, last_published_at, last_publish_outcome, last_publish_error
    FROM pulse_state WHERE user_id=${userId}
  `;
  return rows[0];
}

/**
 * The object a publish would send right now, one seq ahead of the last recorded one, without
 * actually sending it or writing anything — Settings → Pulse's live preview. `undefined` when the
 * recorder has never evaluated this user.
 */
export async function buildPulsePreview(
  sql: Sql,
  userId: string,
  now: Date,
  timeZone: string
): Promise<PublicPulseV1 | undefined> {
  const wire = await readPulseState(sql, userId, now, timeZone);
  if (!wire) return undefined;
  const state = await readPulseStateRow(sql, userId);
  const seq = Number(state?.publish_seq ?? 0) + 1;
  const judgement = {
    state: wire.state,
    ...(wire.doing ? { doing: { kind: wire.doing.kind, id: wire.doing.id, title: wire.doing.title } } : {}),
    private: wire.private,
    ...(wire.lastConfirmedAt ? { confirmedAt: new Date(wire.lastConfirmedAt) } : {})
  };
  return publicPulse(judgement, new Date(wire.since), wire.shares, seq, now);
}

export interface PulseDeliveryStatus {
  lastPublishedAt: string | null;
  lastPublishOutcome: string | null;
  lastPublishError: string | null;
}

/** Settings → Pulse's "last delivery" line. */
export async function readPulseDeliveryStatus(sql: Sql, userId: string): Promise<PulseDeliveryStatus> {
  const state = await readPulseStateRow(sql, userId);
  return {
    lastPublishedAt: state?.last_published_at ? state.last_published_at.toISOString() : null,
    lastPublishOutcome: state?.last_publish_outcome ?? null,
    lastPublishError: state?.last_publish_error ?? null
  };
}

/**
 * Runs one publish pass for `userId`. Called right after `runPulseRecorderTick` writes its
 * judgement, from the same tick route and the same debounced `state_changed` subscriber — never on
 * its own timer, since it has nothing new to say between recorder passes.
 */
export async function runPulsePublisher(
  sql: PoolSql,
  userId: string,
  now: Date = new Date(),
  publish: (pulse: PublicPulseV1) => Promise<PulsePublishResult & { error?: string }> = publishPulseViaProxy
): Promise<PulsePublisherOutcome> {
  // Serialised per user: the 60 s tick route and the debounced `state_changed` subscriber both land
  // here. A caller that finds a publish already in flight skips instead of queueing, so seq is read
  // and written by one pass at a time and a failing tracker is tried once, not once per waiter.
  return sql.begin(async (tx) => {
    const lock = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`pulse_publisher:${userId}`}, 0)) AS locked
    `;
    if (!lock[0]?.locked) return { status: "skipped", reason: "busy" } as const;
    return publishLocked(tx, userId, now, publish);
  });
}

async function publishLocked(
  sql: Sql,
  userId: string,
  now: Date,
  publish: (pulse: PublicPulseV1) => Promise<PulsePublishResult & { error?: string }>
): Promise<PulsePublisherOutcome> {
  const prefRows = await sql<{ pulse_publish_enabled: boolean }[]>`
    SELECT pulse_publish_enabled FROM user_preferences WHERE user_id=${userId}
  `;
  if (!prefRows[0]?.pulse_publish_enabled) return { status: "skipped", reason: "disabled" };

  const userRows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  const timeZone = userRows[0]?.timezone ?? DEFAULT_TIMEZONE;
  const wire = await readPulseState(sql, userId, now, timeZone);
  if (!wire) return { status: "skipped", reason: "not_evaluated" };

  const state = await readPulseStateRow(sql, userId);
  const seq = Number(state?.publish_seq ?? 0) + 1;

  const judgement = {
    state: wire.state,
    ...(wire.doing ? { doing: { kind: wire.doing.kind, id: wire.doing.id, title: wire.doing.title } } : {}),
    private: wire.private,
    ...(wire.lastConfirmedAt ? { confirmedAt: new Date(wire.lastConfirmedAt) } : {})
  };
  const pulse = publicPulse(judgement, new Date(wire.since), wire.shares, seq, now);
  // Excludes `generatedAt`/`seq`/`shares`, which drift on their own — this is the one thing a change
  // in state, `doing`, `private` or `since` is actually judged by (Decision "Publish").
  const changeKey = publicPulseChangeKey(pulse);

  const lastDeliveredAt = state?.last_published_at ?? null;
  const dueToHeartbeat = !lastDeliveredAt || now.getTime() - lastDeliveredAt.getTime() >= HEARTBEAT_MS;
  if (state?.last_published_hash === changeKey && !dueToHeartbeat) {
    return { status: "skipped", reason: "unchanged" };
  }

  const result = await publish(pulse);
  const delivered = result.outcome === "delivered";
  await sql`
    UPDATE pulse_state SET
      publish_seq=${seq},
      last_published_hash=${delivered ? changeKey : (state?.last_published_hash ?? null)},
      last_published_at=${delivered ? now : lastDeliveredAt},
      last_publish_outcome=${result.outcome},
      last_publish_error=${delivered ? null : (result.error ?? null)},
      updated_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId}
  `;
  return { status: "sent", outcome: result.outcome };
}
