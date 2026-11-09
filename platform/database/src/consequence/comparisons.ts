import type postgres from "postgres";
import { fitConsequence, isConsequenceFitActive } from "@openrhen/contracts/consequence-fit";
import { CONSEQUENCE_WORDINGS } from "@openrhen/contracts/consequence-question";
import { loadComparisons, loadPoolRows, pgArrayLiteral, type ConsequencePool } from "./pool-load.js";
import { nextConsequenceGroup, PAIR_COOLDOWN_DAYS, type GroupCandidate } from "./next-group.js";
import { inTransaction, lockConsequencePool, lockConsequencePools, refitConsequence, userLocalDay } from "./refit.js";
import { localDay, usableComparisons, type ComparisonBasis } from "./usable-comparisons.js";

/**
 * Issuing groups and recording answers (comparison-consequence-ranking design, 3.4 and 3.6). Every group handed out is
 * recorded in `consequence_groups_issued`, and an answer is accepted only for a group that was issued, exactly once,
 * with exactly its item ids. `recordComparison` stores each item's stars and material-field hash at answer time (what
 * the fit later compares against to drop a stale answer), is idempotent on `(user, idempotency key)`, and refits in the
 * same transaction. Refused answers throw `ConsequenceComparisonError` with a message that names the right group and the
 * next call, so a caller (the portal card, `rhen rank`, an agent) can correct itself without guessing.
 */
type Sql = postgres.Sql | postgres.TransactionSql;

export const QUESTION_WORDINGS = CONSEQUENCE_WORDINGS;
export type QuestionWording = (typeof QUESTION_WORDINGS)[number];

export type ComparisonErrorCode =
  | "bad_input"
  | "group_not_found"
  | "group_already_answered"
  | "ranking_mismatch"
  | "items_changed"
  | "basis_not_allowed"
  | "idempotency_conflict";

/** The group a refusal is about (the one the answer named, or the one waiting for an answer), so a caller can build the exact next call. */
export interface ComparisonErrorGroup {
  groupId: string;
  itemIds: string[];
  /** The group can no longer be answered (answered already, or an item is gone), so the next call asks for a new group. */
  askNext?: boolean;
}

export class ConsequenceComparisonError extends Error {
  constructor(
    readonly code: ComparisonErrorCode,
    message: string,
    readonly group?: ComparisonErrorGroup
  ) {
    super(message);
    this.name = "ConsequenceComparisonError";
  }
}

export interface IssuedGroup {
  groupId: string;
  pool: ConsequencePool;
  /** Sorted, the order the group is stored in; present them in any order. */
  itemIds: string[];
  wording: string;
  issuedAt: string;
  /** True when an earlier unanswered group was handed out again instead of a new one. */
  reissued: boolean;
  /** Some item is private (effective privacy). The caller decides what to show; agent-facing use never gets one. */
  containsPrivate: boolean;
}

export interface IssueOptions {
  now?: Date;
  wording?: string;
  /** Skip private items. */
  agentFacing?: boolean;
}

interface IssuedRow {
  id: string;
  pool: ConsequencePool;
  item_ids: string[];
  wording: string;
  issued_at: Date;
  answered_at: Date | null;
  answered_comparison_id: string | null;
}

const issuedColumns = (sql: Sql) =>
  sql`id::text AS id, pool, to_jsonb(item_ids) AS item_ids, wording, issued_at, answered_at, answered_comparison_id::text AS answered_comparison_id`;

/**
 * Hands out the next group for a pool, or null when no group can be formed (fewer than two comparable items, or every
 * pair is cooling). An earlier group still waiting for an answer is handed out again first, as long as all its items
 * are still live, so asking twice never uses up the cool-down.
 */
export async function issueNextConsequenceGroup(
  sql: Sql,
  userId: string,
  pool: ConsequencePool,
  options: IssueOptions = {}
): Promise<IssuedGroup | null> {
  const now = options.now ?? new Date();
  const wording = options.wording ?? QUESTION_WORDINGS[0];
  return inTransaction(sql, async (tx) => {
    await lockConsequencePool(tx, userId, pool);
    const rows = await loadPoolRows(tx, userId, pool);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const live = (id: string) => {
      const row = byId.get(id);
      return row !== undefined && isConsequenceFitActive(row.status) && !(options.agentFacing && row.private);
    };

    const waiting = await tx<IssuedRow[]>`
      SELECT ${issuedColumns(tx)} FROM consequence_groups_issued
      WHERE user_id = ${userId} AND pool = ${pool} AND answered_at IS NULL ORDER BY issued_at, id`;
    for (const group of waiting)
      if (group.item_ids.every(live))
        return {
          groupId: group.id,
          pool,
          itemIds: group.item_ids,
          wording: group.wording,
          issuedAt: new Date(group.issued_at).toISOString(),
          reissued: true,
          containsPrivate: group.item_ids.some((id) => byId.get(id)?.private)
        };

    const timezone =
      (await tx<{ timezone: string }[]>`SELECT timezone FROM users WHERE id = ${userId}`)[0]?.timezone ?? "UTC";
    const usable = usableComparisons(rows, await loadComparisons(tx, userId, pool), localDay(now, timezone), timezone);
    const fitted = new Map(
      fitConsequence(
        rows.map((row) => ({ id: row.id, stars: row.stars, status: row.status })),
        usable.comparisons
      ).map((result) => [result.id, result])
    );
    const candidates: GroupCandidate[] = rows
      .filter((row) => isConsequenceFitActive(row.status))
      .map((row) => ({
        id: row.id,
        value: fitted.get(row.id)?.value ?? row.stars,
        variance: fitted.get(row.id)?.variance ?? 0,
        cohort: row.cohort,
        private: row.private
      }));
    const since = new Date(now.getTime() - PAIR_COOLDOWN_DAYS * 86_400_000);
    const recent = await tx<{ item_ids: string[]; issued_at: Date }[]>`
      SELECT to_jsonb(item_ids) AS item_ids, issued_at FROM consequence_groups_issued
      WHERE user_id = ${userId} AND pool = ${pool} AND issued_at > ${since}`;
    const next = nextConsequenceGroup(candidates, {
      now,
      recentGroups: recent.map((group) => ({ itemIds: group.item_ids, askedAt: new Date(group.issued_at) })),
      ...(options.agentFacing !== undefined ? { agentFacing: options.agentFacing } : {})
    });
    if (!next) return null;
    const itemIds = [...next.itemIds].sort();
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO consequence_groups_issued (user_id, pool, item_ids, wording, issued_at)
      VALUES (${userId}, ${pool}, ${pgArrayLiteral(itemIds)}::text[], ${wording}, ${now})
      RETURNING id::text AS id`;
    return {
      groupId: inserted[0]!.id,
      pool,
      itemIds,
      wording,
      issuedAt: now.toISOString(),
      reissued: false,
      containsPrivate: next.containsPrivate
    };
  });
}

export interface RecordComparisonInput {
  groupId: string;
  /** The group's item ids, best first. Omit when `tie` is true. */
  rankedIds?: readonly string[];
  /** "Equal / can't decide": recorded, cools the group, carries no information for the fit. */
  tie?: boolean;
  answeredBy: "person" | "agent";
  basis: ComparisonBasis;
  /** The owner's words, required for an agent's `stated` answer. */
  evidence?: string | null;
  idempotencyKey: string;
  /** When sent, must be the wording the group was asked under. */
  wording?: string;
  /** The answer comes from an agent-facing caller: a group holding a private item is treated as not issued to it. */
  agentFacing?: boolean;
  now?: Date;
}

export interface RecordedComparison {
  comparisonId: string;
  groupId: string;
  /** True when this exact answer had already been recorded under the same key. */
  replayed: boolean;
}

interface StoredAnswer {
  id: string;
  group_id: string;
  ranking: string[] | null;
  tie: boolean;
}

function sameAnswer(stored: StoredAnswer, groupId: string, ranking: readonly string[] | null, tie: boolean): boolean {
  return (
    stored.group_id === groupId &&
    stored.tie === tie &&
    (ranking === null ? stored.ranking === null : (stored.ranking ?? []).join(",") === ranking.join(","))
  );
}

function describeGroup(group: { id: string; pool: string; item_ids: readonly string[] }): string {
  return `group ${group.id} (${group.pool}s: ${group.item_ids.join(", ")})`;
}

/**
 * Records one answer to an issued group and refits. See the header for the rules; the refit runs inside the same
 * transaction and cannot fail the write (`refitConsequence` reports its own failure).
 */
export async function recordComparison(
  sql: Sql,
  userId: string,
  input: RecordComparisonInput
): Promise<RecordedComparison> {
  const now = input.now ?? new Date();
  const key = input.idempotencyKey.trim();
  if (!key)
    throw new ConsequenceComparisonError(
      "bad_input",
      "idempotencyKey is required: send a fresh unique value per answer, and the same value when retrying it."
    );
  const tie = input.tie === true;
  if (tie && input.rankedIds?.length)
    throw new ConsequenceComparisonError("bad_input", "Send either rankedIds (best first) or tie: true, not both.");
  const ranking = tie ? null : [...(input.rankedIds ?? [])];
  if (!tie && ranking!.length === 0)
    throw new ConsequenceComparisonError(
      "bad_input",
      "rankedIds is empty. Send every id of the group once, best first, or tie: true if they are equal or you cannot decide."
    );

  return inTransaction(sql, async (tx) => {
    // Both pools up front, in the refit's own order: the group's pool is not known until it is read, and taking the
    // locks one at a time here against the refit's project-then-action order deadlocks concurrent answers.
    await lockConsequencePools(tx, userId);
    const existing = await tx<StoredAnswer[]>`
      SELECT id::text AS id, group_id::text AS group_id, to_jsonb(ranking) AS ranking, tie
      FROM consequence_comparisons WHERE user_id = ${userId} AND idempotency_key = ${key}`;
    if (existing[0]) {
      if (sameAnswer(existing[0], input.groupId, ranking, tie))
        return { comparisonId: existing[0].id, groupId: input.groupId, replayed: true };
      throw new ConsequenceComparisonError(
        "idempotency_conflict",
        `idempotencyKey ${key} already recorded a different answer (comparison ${existing[0].id}, group ${existing[0].group_id}). Use a new key for a new answer, or resend the original answer to retry it.`
      );
    }

    const groups = await tx<IssuedRow[]>`
      SELECT ${issuedColumns(tx)} FROM consequence_groups_issued
      WHERE id::text = ${input.groupId} AND user_id = ${userId} FOR UPDATE`;
    const group = groups[0];
    // A group with a private item was never shown to an agent-facing caller, so to it the group does not exist: decide
    // that before any message names the group or its ids.
    const hasPrivate = async (candidate: IssuedRow) =>
      (await loadPoolRows(tx, userId, candidate.pool)).some(
        (row) => candidate.item_ids.includes(row.id) && row.private
      );
    if (!group || (input.agentFacing && (await hasPrivate(group)))) {
      let waiting: IssuedRow | undefined;
      for (const candidate of await tx<IssuedRow[]>`
        SELECT ${issuedColumns(tx)} FROM consequence_groups_issued
        WHERE user_id = ${userId} AND answered_at IS NULL ORDER BY issued_at DESC, id`) {
        if (input.agentFacing && (await hasPrivate(candidate))) continue;
        waiting = candidate;
        break;
      }
      throw new ConsequenceComparisonError(
        "group_not_found",
        `No group ${input.groupId} was issued to you. ${
          waiting
            ? `The group waiting for an answer is ${describeGroup(waiting)}: answer that one with its groupId and exactly those ids.`
            : "Nothing is waiting for an answer: ask for the next group, then answer it with the groupId it returns."
        }`,
        waiting ? { groupId: waiting.id, itemIds: waiting.item_ids } : undefined
      );
    }
    if (group.answered_at) {
      throw new ConsequenceComparisonError(
        "group_already_answered",
        `Group ${group.id} was already answered (comparison ${group.answered_comparison_id}). A group can be answered once: ask for the next group and answer that.`,
        { groupId: group.id, itemIds: group.item_ids, askNext: true }
      );
    }
    if (input.wording !== undefined && input.wording !== group.wording)
      throw new ConsequenceComparisonError(
        "bad_input",
        `Group ${group.id} was asked as "${group.wording}", not "${input.wording}". Leave wording out, or send "${group.wording}".`,
        { groupId: group.id, itemIds: group.item_ids }
      );
    if (!tie) {
      const expected = [...group.item_ids].sort();
      const sent = [...ranking!].sort();
      if (expected.length !== sent.length || expected.some((id, index) => id !== sent[index]))
        throw new ConsequenceComparisonError(
          "ranking_mismatch",
          `rankedIds does not match ${describeGroup(group)}. Send exactly its ${group.item_ids.length} ids, each once, best first (the one you would most regret not finishing first), or tie: true. You sent: ${ranking!.join(", ")}.`,
          { groupId: group.id, itemIds: group.item_ids }
        );
    }
    if (input.answeredBy === "person" && input.basis !== "stated")
      throw new ConsequenceComparisonError(
        "basis_not_allowed",
        'A person\'s answer has basis "stated". Resend it with basis: "stated".',
        { groupId: group.id, itemIds: group.item_ids }
      );
    if (input.answeredBy === "agent" && input.basis === "stated" && !input.evidence?.trim())
      throw new ConsequenceComparisonError(
        "basis_not_allowed",
        'A "stated" answer from an agent needs the owner\'s own words as evidence. Resend with evidence set to what they said, or with basis "observed" (seen in their behaviour, with evidence) or "inferred" (your guess, counted at half weight).',
        { groupId: group.id, itemIds: group.item_ids }
      );
    if (input.answeredBy === "agent" && input.basis === "observed" && !input.evidence?.trim())
      throw new ConsequenceComparisonError(
        "basis_not_allowed",
        'An "observed" answer needs evidence naming what was observed. Resend with evidence set.',
        { groupId: group.id, itemIds: group.item_ids }
      );

    const rows = await loadPoolRows(tx, userId, group.pool);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const gone = group.item_ids.filter((id) => {
      const row = byId.get(id);
      return !row || !isConsequenceFitActive(row.status);
    });
    if (gone.length)
      throw new ConsequenceComparisonError(
        "items_changed",
        `${describeGroup(group)} can no longer be answered: ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} no longer active. Ask for the next group.`,
        { groupId: group.id, itemIds: group.item_ids, askNext: true }
      );
    const stars = group.item_ids.map((id) => byId.get(id)!.stars);
    const hashes = group.item_ids.map((id) => byId.get(id)!.materialHash);

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO consequence_comparisons
        (user_id, pool, item_ids, item_stars, item_hashes, ranking, tie, answered_by, basis, evidence, question_wording,
         asked_at, answered_at, idempotency_key, group_id)
      VALUES
        (${userId}, ${group.pool}, ${pgArrayLiteral(group.item_ids)}::text[], ${pgArrayLiteral(stars)}::smallint[],
         ${pgArrayLiteral(hashes)}::text[], ${ranking ? pgArrayLiteral(ranking) : null}::text[], ${tie},
         ${input.answeredBy}, ${input.basis}, ${input.evidence?.trim() || null}, ${group.wording},
         ${new Date(group.issued_at)}, ${now}, ${key}, ${group.id}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id`;
    if (!inserted[0]) {
      // Lost a race on the key or the group: whichever won decides whether this is a replay or a refusal.
      const winner = await tx<StoredAnswer[]>`
        SELECT id::text AS id, group_id::text AS group_id, to_jsonb(ranking) AS ranking, tie
        FROM consequence_comparisons WHERE user_id = ${userId} AND (idempotency_key = ${key} OR group_id = ${group.id}::uuid)
        ORDER BY (idempotency_key = ${key}) DESC LIMIT 1`;
      if (winner[0] && sameAnswer(winner[0], group.id, ranking, tie))
        return { comparisonId: winner[0].id, groupId: group.id, replayed: true };
      throw new ConsequenceComparisonError(
        "group_already_answered",
        `Group ${group.id} was answered at the same moment by another call. Ask for the next group and answer that.`
      );
    }
    await tx`UPDATE consequence_groups_issued SET answered_at = ${now}, answered_comparison_id = ${inserted[0].id}::uuid WHERE id = ${group.id}::uuid`;
    await refitConsequence(tx, userId, await userLocalDay(tx, userId, now));
    return { comparisonId: inserted[0].id, groupId: group.id, replayed: false };
  });
}
