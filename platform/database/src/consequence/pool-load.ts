import type postgres from "postgres";
import type { LoggedComparison, PoolItem } from "./usable-comparisons.js";
import { materialHash } from "./material-hash.js";

/**
 * Reads one user's items and comparison log for one pool. Raw SQL on the portal's tables, the same way
 * `planning/completion-ratios.ts` is, so it works on any handle: the engine worker's and the restore tool's clients are
 * not built with `fetch_types`, so arrays are read as JSON rather than relied on to arrive as arrays.
 */
type Sql = postgres.Sql | postgres.TransactionSql;

export type ConsequencePool = "project" | "action";
export const CONSEQUENCE_POOLS: readonly ConsequencePool[] = ["project", "action"];

export interface PoolRow extends PoolItem {
  title: string;
  /** Who it may be compared with: one constant for projects, the project id for actions. */
  cohort: string;
  /** Effective privacy: the area's, the project's and (for an action) its own, OR-inherited. */
  private: boolean;
  refined: number | null;
  refinedForStars: number | null;
  refinedAsOf: string | null;
}

interface RawRow {
  id: string;
  stars: number;
  status: string;
  title: string;
  parent_id: string;
  definition_of_done: string | null;
  deadline_a: Date | string | null;
  deadline_b: Date | string | null;
  is_private: boolean;
  refined: number | null;
  for_stars: number | null;
  as_of: string | null;
}

/** The value as a finite number inside the stored range, else null: a bad stored value reads as no value. */
function cleanRefined(value: number | string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 6 ? number : null;
}

function toRow(raw: RawRow, cohort: string): PoolRow {
  const refined = cleanRefined(raw.refined);
  const forStars = raw.for_stars === null ? null : Number(raw.for_stars);
  const valid = refined !== null && forStars !== null && forStars >= 1 && forStars <= 5;
  return {
    id: raw.id,
    stars: Number(raw.stars),
    status: raw.status,
    title: raw.title,
    materialHash: materialHash({
      title: raw.title,
      definitionOfDone: raw.definition_of_done,
      deadlines: [raw.deadline_a, raw.deadline_b],
      parentId: raw.parent_id
    }),
    cohort,
    private: raw.is_private,
    refined: valid ? refined : null,
    refinedForStars: valid ? forStars : null,
    refinedAsOf: valid ? raw.as_of : null
  };
}

/** Every project of the user (projects pool) or every plain action of the user (actions pool), in id order. */
export async function loadPoolRows(sql: Sql, userId: string, pool: ConsequencePool): Promise<PoolRow[]> {
  if (pool === "project") {
    const rows = await sql<RawRow[]>`
      SELECT p.id::text AS id, p.consequence AS stars, p.status::text AS status, p.title,
        p.outcome_id::text AS parent_id, o.definition_of_done,
        p.external_deadline_at AS deadline_a, p.internal_deadline_at AS deadline_b,
        (a.private OR p.private) AS is_private,
        p.consequence_refined AS refined, p.consequence_refined_for_stars AS for_stars,
        to_char(p.consequence_refined_as_of, 'YYYY-MM-DD') AS as_of
      FROM projects p
      JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId}
      ORDER BY p.id`;
    return rows.map((raw) => toRow(raw, "projects"));
  }
  const rows = await sql<RawRow[]>`
    SELECT ac.id::text AS id, ac.consequence AS stars, ac.status::text AS status, ac.title,
      ac.project_id::text AS parent_id, ac.completion_condition AS definition_of_done,
      ac.deadline_at AS deadline_a, ac.latest_start_at AS deadline_b,
      (a.private OR p.private OR ac.private) AS is_private,
      ac.consequence_refined AS refined, ac.consequence_refined_for_stars AS for_stars,
      to_char(ac.consequence_refined_as_of, 'YYYY-MM-DD') AS as_of
    FROM actions ac
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes o ON o.id = p.outcome_id
    JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND ac.deliverable_id IS NULL
    ORDER BY ac.id`;
  return rows.map((raw) => toRow(raw, raw.parent_id));
}

interface RawLog {
  id: string;
  item_ids: string[];
  item_stars: number[];
  item_hashes: string[];
  ranking: string[] | null;
  tie: boolean;
  basis: string;
  answered_at: Date;
}

/** The user's log for a pool in a stable order (answer time, then id). */
export async function loadComparisons(sql: Sql, userId: string, pool: ConsequencePool): Promise<LoggedComparison[]> {
  const rows = await sql<RawLog[]>`
    SELECT id::text AS id, to_jsonb(item_ids) AS item_ids, to_jsonb(item_stars) AS item_stars,
      to_jsonb(item_hashes) AS item_hashes, to_jsonb(ranking) AS ranking, tie, basis, answered_at
    FROM consequence_comparisons
    WHERE user_id = ${userId} AND pool = ${pool}
    ORDER BY answered_at, id`;
  return rows.map((row) => ({
    id: row.id,
    itemIds: row.item_ids,
    itemStars: row.item_stars.map(Number),
    itemHashes: row.item_hashes,
    ranking: row.ranking,
    tie: row.tie,
    basis: row.basis,
    answeredAt: new Date(row.answered_at)
  }));
}

/** A JS list as a Postgres array literal, for `${pgArrayLiteral(list)}::text[]`; safe whatever the client's type setup. */
export function pgArrayLiteral(values: readonly (string | number)[]): string {
  return `{${values.map((value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
