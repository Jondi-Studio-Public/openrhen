import {
  effectiveMode,
  proposeRuleLinks,
  scoreProposers,
  selectNewSuggestions,
  planLinkSchema,
  type PlanLink,
  type PlanMapMode,
  type ProposerItem,
  type ProposerScore,
  type ProposerSnapshot
} from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * Runs the rule proposers for one user. Advisory only: it writes
 * `suggested` rows to `plan_links` and notes to `plan_shadow_log`, and touches no plan row. The
 * `proposers` switch gates it: `off` does nothing; `shadow` and `on` both only suggest, because nothing
 * reads a suggested link until the owner confirms it. Only a person sets the switch.
 */

const ADDON = "proposers";

export interface ProposerRunResult {
  mode: PlanMapMode;
  suggested: number;
  revived: number;
  scores: ProposerScore[];
}

async function loadSnapshot(sql: Sql, userId: string): Promise<ProposerSnapshot> {
  const items = (type: ProposerItem["type"], rows: { id: string; title: string | null }[]): ProposerItem[] =>
    rows.filter((row) => row.title).map((row) => ({ type, id: row.id, title: row.title! }));
  const projects = await sql<{ id: string; title: string }[]>`
    SELECT p.id::text AS id, p.title FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND p.status = 'active'`;
  const deliverables = await sql<{ id: string; title: string }[]>`
    SELECT d.id::text AS id, d.title FROM deliverables d JOIN projects p ON p.id = d.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND p.status = 'active'`;
  const actions = await sql<{ id: string; title: string }[]>`
    SELECT x.id::text AS id, x.title FROM actions x JOIN projects p ON p.id = x.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND p.status = 'active' AND x.status NOT IN ('done', 'cancelled', 'archived')`;
  // A recurring commitment is linked once, on its rule, so the link applies to every date. A one-off
  // commitment is one that belongs to no rule; an occurrence of a series is never linked by itself.
  const commitments = await sql<{ id: string; title: string }[]>`
    SELECT id::text AS id, title FROM commitment_recurrence_rules
    WHERE user_id = ${userId} AND (end_date IS NULL OR end_date >= current_date)
    UNION ALL
    SELECT id::text AS id, title FROM commitments
    WHERE user_id = ${userId} AND recurrence_rule_id IS NULL AND ends_at >= now()`;
  const sources = await sql<{ id: string; title: string | null }[]>`
    SELECT id::text AS id, title FROM sources WHERE user_id = ${userId} AND title IS NOT NULL`;
  const subjects = await sql<{ id: string }[]>`
    SELECT id FROM plan_subjects WHERE user_id = ${userId} AND status = 'active'`;
  const [preferences] = await sql<{ plan_code_pattern: string | null }[]>`
    SELECT plan_code_pattern FROM user_preferences WHERE user_id = ${userId}`;
  return {
    projects: items("project", projects),
    deliverables: items("deliverable", deliverables),
    actions: items("action", actions),
    commitments: items("commitment", commitments),
    sources: items("source", sources),
    subjectIds: subjects.map((row) => row.id),
    codePattern: preferences?.plan_code_pattern ?? null
  };
}

interface StoredLinkRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  kind: string;
  weight: number | null;
  status: string;
  proposer: string;
  evidence: unknown;
  created_at: Date;
  decided_at: Date | null;
  last_confirmed_at: Date | null;
}

function toLink(row: StoredLinkRow): PlanLink {
  return planLinkSchema.parse({
    id: row.id,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    kind: row.kind,
    weight: row.weight,
    status: row.status,
    proposer: row.proposer,
    evidence: row.evidence,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    lastConfirmedAt: row.last_confirmed_at ? new Date(row.last_confirmed_at).toISOString() : null
  });
}

export async function readProposerScores(sql: Sql, userId: string): Promise<ProposerScore[]> {
  const rows = await sql<StoredLinkRow[]>`
    SELECT id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at, decided_at, last_confirmed_at
    FROM plan_links WHERE user_id = ${userId} AND proposer <> 'owner'`;
  return scoreProposers(rows.map(toLink));
}

/**
 * Suggests links from the rules and logs the outcome. Idempotent: a pair already suggested, confirmed or
 * rejected is skipped, and an expired one is revived only when its evidence changed.
 */
export async function runPlanMapProposers(
  sql: Sql,
  userId: string,
  now: Date = new Date()
): Promise<ProposerRunResult> {
  const mode = effectiveMode(ADDON, undefined);
  const snapshot = await loadSnapshot(sql, userId);
  const existingRows = await sql<StoredLinkRow[]>`
    SELECT id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at, decided_at, last_confirmed_at
    FROM plan_links WHERE user_id = ${userId}`;
  const existing = existingRows.map(toLink);
  const fresh = selectNewSuggestions(proposeRuleLinks(snapshot), existing);

  const runId = crypto.randomUUID();
  let suggested = 0;
  let revived = 0;
  for (const link of fresh) {
    const stored = existing.find(
      (row) =>
        row.kind === link.kind &&
        row.fromType === link.fromType &&
        row.fromId === link.fromId &&
        row.toType === link.toType &&
        row.toId === link.toId
    );
    if (stored) {
      await sql`
        UPDATE plan_links SET status = 'suggested', proposer = ${link.proposer}, evidence = ${sql.json(link.evidence as never)},
          created_at = ${now}, decided_at = NULL
        WHERE id = ${stored.id} AND user_id = ${userId} AND status = 'expired'`;
      revived += 1;
    } else {
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO plan_links (user_id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at)
        VALUES (${userId}, ${link.fromType}, ${link.fromId}, ${link.toType}, ${link.toId}, ${link.kind}, NULL,
          'suggested', ${link.proposer}, ${sql.json(link.evidence as never)}, ${now})
        ON CONFLICT (user_id, from_type, from_id, to_type, to_id, kind) DO NOTHING
        RETURNING id`;
      // An overlapping run may have inserted the pair first; count and log only real inserts.
      if (inserted.length === 0) continue;
      suggested += 1;
    }
    await sql`
      INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
      VALUES (${userId}, ${runId}, ${ADDON}, ${link.fromType}, ${link.fromId},
        ${sql.json({ action: "suggest", kind: link.kind, proposer: link.proposer, toType: link.toType, toId: link.toId } as never)},
        ${link.evidence[0] ?? ""}, ${now})`;
  }

  const scores = await readProposerScores(sql, userId);
  for (const score of scores) {
    await sql`
      INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
      VALUES (${userId}, ${runId}, ${ADDON}, 'proposer', ${`${score.proposer}:${score.kind}`},
        ${sql.json({ action: "score", ...score } as never)},
        ${score.acceptRate === null ? "No decisions yet." : `Accept rate ${Math.round(score.acceptRate * 100)}% over ${score.decisions} decisions.`},
        ${now})`;
  }
  return { mode, suggested, revived, scores };
}

/** Logs one decision on a suggestion so accept and reject rates can be read back from `plan_shadow_log`. */
export async function logProposerDecision(
  sql: Sql,
  userId: string,
  link: { id: string; fromType: string; fromId: string; toType: string; toId: string; kind: string; proposer: string },
  decision: "accepted" | "rejected",
  now: Date
): Promise<void> {
  await sql`
    INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
    VALUES (${userId}, 'decision', ${ADDON}, ${link.fromType}, ${link.fromId},
      ${sql.json({ action: decision, linkId: link.id, kind: link.kind, proposer: link.proposer, toType: link.toType, toId: link.toId } as never)},
      ${`${link.proposer} ${link.kind} suggestion ${decision}.`}, ${now})`;
}
