import type postgres from "postgres";
import { issueNextConsequenceGroup, type IssuedGroup, type IssueOptions } from "./comparisons.js";
import { CONSEQUENCE_POOLS, type ConsequencePool } from "./pool-load.js";
import { PAIR_COOLDOWN_DAYS } from "./next-group.js";

/**
 * The next group for a person who did not name a pool (comparison-consequence-ranking design, 3.6): the pool with an
 * unanswered group goes first (so asking again returns the group still waiting), then the pool asked about least in the
 * cool-down window (projects first on a tie), and when that pool has nothing to ask the other one is tried. `pool`
 * limits it to one. Deterministic for a given history and clock.
 */
type Sql = postgres.Sql | postgres.TransactionSql;

export interface IssueAnyOptions extends IssueOptions {
  pool?: ConsequencePool;
}

export async function issueNextConsequenceGroupForUser(
  sql: Sql,
  userId: string,
  options: IssueAnyOptions = {}
): Promise<IssuedGroup | null> {
  const { pool: only, ...issue } = options;
  const now = issue.now ?? new Date();
  const order: readonly ConsequencePool[] = only ? [only] : await poolOrder(sql, userId, now);
  for (const pool of order) {
    const group = await issueNextConsequenceGroup(sql, userId, pool, { ...issue, now });
    if (group) return group;
  }
  return null;
}

async function poolOrder(sql: Sql, userId: string, now: Date): Promise<ConsequencePool[]> {
  const since = new Date(now.getTime() - PAIR_COOLDOWN_DAYS * 86_400_000);
  const rows = await sql<{ pool: ConsequencePool; waiting: string; recent: string }[]>`
    SELECT pool, count(*) FILTER (WHERE answered_at IS NULL) AS waiting, count(*) AS recent
    FROM consequence_groups_issued
    WHERE user_id = ${userId} AND issued_at > ${since}
    GROUP BY pool`;
  const stat = (pool: ConsequencePool) => {
    const row = rows.find((candidate) => candidate.pool === pool);
    return { waiting: Number(row?.waiting ?? 0), recent: Number(row?.recent ?? 0) };
  };
  return [...CONSEQUENCE_POOLS].sort((a, b) => {
    const sa = stat(a);
    const sb = stat(b);
    return (
      Number(sb.waiting > 0) - Number(sa.waiting > 0) ||
      sa.recent - sb.recent ||
      CONSEQUENCE_POOLS.indexOf(a) - CONSEQUENCE_POOLS.indexOf(b)
    );
  });
}
