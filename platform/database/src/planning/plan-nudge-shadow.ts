import type postgres from "postgres";
import {
  NUDGE_CAPS_DAYS,
  NUDGE_HORIZON_DAYS,
  computeNudge,
  planLinkSchema,
  planNudgeHandle,
  type NudgeCandidate,
  type NudgeCapDays,
  type NudgeCapResult,
  type NudgeCapSummary,
  type NudgeTrigger,
  type PlanLink
} from "@openrhen/contracts";

/**
 * The shadow pass for the plan-map ranking nudge. After a
 * planning run is published it reads that run's ranking, computes the capped boost at each of the three
 * caps, and writes what would have moved to `plan_shadow_log`. It never writes the ranking, a plan row or
 * a link, and it never throws into the planning job. The `nudge` switch gates it: `off` (the default,
 * and an absent row) does nothing. `shadow` and `on` behave the same here, because applying a boost to
 * the live ranking is not built: `on` is the owner's later decision, made from this evidence.
 */

const ADDON = "nudge";
/** One shadow pass per user at most this often, so a burst of recalculations writes one comparison. */
export const NUDGE_MIN_INTERVAL_MINUTES = 30;
const DAY_MS = 86_400_000;

type Sql = postgres.Sql;

interface ResultCandidate {
  action?: {
    id?: string;
    templateActionId?: string;
    deliverableId?: string;
    projectId?: string;
    title?: string;
    schedulingMode?: string;
  };
  totalScore?: number;
  eligible?: boolean;
  criticalTier?: string;
}

/** The ranking in a persisted result, as the pure nudge reads it. Tiered (deadline) candidates read as rank 0, ordinary as 1. */
export function nudgeCandidatesFrom(
  result: { recommendation?: unknown },
  dueByProject: ReadonlyMap<string, string>
): NudgeCandidate[] {
  const raw = (result.recommendation as { candidates?: ResultCandidate[] } | undefined)?.candidates ?? [];
  const out: NudgeCandidate[] = [];
  raw.forEach((candidate, index) => {
    const deliverableId = candidate.action?.deliverableId;
    const actionId = candidate.action?.templateActionId ?? candidate.action?.id;
    const targetId = deliverableId ?? actionId;
    if (!targetId) return;
    out.push({
      targetType: deliverableId ? "deliverable" : "action",
      targetId,
      title: candidate.action?.title ?? targetId,
      rank: index + 1,
      totalScore: candidate.totalScore ?? 0,
      eligible: candidate.eligible === true,
      criticalRank: candidate.criticalTier === "ordinary" || candidate.criticalTier === "stale_date" ? 1 : 0,
      recurring: candidate.action?.schedulingMode === "recurring" || candidate.action?.schedulingMode === "cadence",
      dueAt: (candidate.action?.projectId && dueByProject.get(candidate.action.projectId)) || null
    });
  });
  return out;
}

async function confirmedLinks(sql: Sql, userId: string): Promise<PlanLink[]> {
  const rows = await sql<
    {
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
    }[]
  >`
    SELECT id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at, decided_at, last_confirmed_at
    FROM plan_links
    WHERE user_id = ${userId} AND status = 'confirmed' AND kind IN ('about', 'prepares')`;
  return rows.map((row) =>
    planLinkSchema.parse({
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
    })
  );
}

const earliest = (a: Date | null, b: Date | null): Date | null => (a && b ? (a < b ? a : b) : (a ?? b));

/** Deadlines and exam commitments inside the horizon, for the items the confirmed links are about. */
async function loadTriggers(sql: Sql, userId: string, now: Date): Promise<NudgeTrigger[]> {
  const horizon = new Date(now.getTime() + NUDGE_HORIZON_DAYS * DAY_MS);
  const projects = await sql<{ id: string; title: string; external: Date | null; internal: Date | null }[]>`
    SELECT p.id::text AS id, p.title, p.external_deadline_at AS external, p.internal_deadline_at AS internal
    FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND p.status = 'active'
      AND LEAST(COALESCE(p.external_deadline_at, 'infinity'), COALESCE(p.internal_deadline_at, 'infinity'))
        BETWEEN ${now} AND ${horizon}`;
  const deliverables = await sql<{ id: string; title: string; external: Date | null; internal: Date | null }[]>`
    SELECT d.id::text AS id, d.title, d.external_deadline_at AS external, d.internal_deadline_at AS internal
    FROM deliverables d JOIN projects p ON p.id = d.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND p.status = 'active' AND d.status NOT IN ('completed', 'cancelled')
      AND LEAST(COALESCE(d.external_deadline_at, 'infinity'), COALESCE(d.internal_deadline_at, 'infinity'))
        BETWEEN ${now} AND ${horizon}`;
  // A link on a recurring series sits on its rule, so an exam occurrence is keyed by its rule when it has one.
  const exams = await sql<{ id: string; title: string; starts_at: Date }[]>`
    SELECT COALESCE(recurrence_rule_id, id)::text AS id, title, starts_at
    FROM commitments
    WHERE user_id = ${userId} AND status <> 'cancelled' AND starts_at BETWEEN ${now} AND ${horizon} AND title ~* '\\mexam'`;
  return [
    ...projects.map((row) => ({
      type: "project" as const,
      id: row.id,
      title: row.title,
      dueAt: earliest(row.external, row.internal)!.toISOString(),
      kind: "deadline" as const
    })),
    ...deliverables.map((row) => ({
      type: "deliverable" as const,
      id: row.id,
      title: row.title,
      dueAt: earliest(row.external, row.internal)!.toISOString(),
      kind: "deadline" as const
    })),
    ...exams.map((row) => ({
      type: "commitment" as const,
      id: row.id,
      title: row.title,
      dueAt: new Date(row.starts_at).toISOString(),
      kind: "exam" as const
    }))
  ];
}

async function projectDeadlines(sql: Sql, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; external: Date | null; internal: Date | null }[]>`
    SELECT id::text AS id, external_deadline_at AS external, internal_deadline_at AS internal
    FROM projects WHERE id::text IN (SELECT jsonb_array_elements_text(${sql.json(ids as never)}))`;
  const out = new Map<string, string>();
  for (const row of rows) {
    const due = earliest(row.external, row.internal);
    if (due) out.set(row.id, due.toISOString());
  }
  return out;
}

/** Writes one run's shadow rows: a `run` row per cap (so quiet runs still count), then every move and displacement. */
async function logRun(sql: Sql, userId: string, runId: string, results: NudgeCapResult[], now: Date) {
  const rows: {
    itemType: string;
    itemId: string;
    wouldHave: Record<string, unknown>;
    reason: string;
  }[] = [];
  for (const result of results) {
    const base = { capDays: result.capDays, capPoints: result.capPoints };
    rows.push({
      itemType: "run",
      itemId: `cap-${result.capDays}`,
      wouldHave: { ...base, action: "run", boosted: result.boosted.length, moved: result.moves.length },
      reason: `Cap ${result.capDays} day: ${result.moves.length} would rise, ${result.displaced.length} would fall.`
    });
    for (const move of result.moves) {
      rows.push({
        itemType: move.targetType,
        itemId: move.targetId,
        wouldHave: {
          ...base,
          action: "boost",
          title: move.title,
          rankBefore: move.rankBefore,
          rankAfter: move.rankAfter,
          scoreBefore: move.scoreBefore,
          boost: move.boost
        },
        reason: move.reason
      });
    }
    for (const slip of result.displaced) {
      rows.push({
        itemType: slip.targetType,
        itemId: slip.targetId,
        wouldHave: {
          ...base,
          action: "displaced",
          title: slip.title,
          rankBefore: slip.rankBefore,
          rankAfter: slip.rankAfter,
          dueAt: slip.dueAt,
          dueWithinHorizon: slip.dueWithinHorizon
        },
        reason: `Would fall from ${slip.rankBefore} to ${slip.rankAfter} under the ${result.capDays} day cap.`
      });
    }
  }
  for (const row of rows) {
    await sql`
      INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
      VALUES (${userId}, ${runId}, ${ADDON}, ${row.itemType}, ${row.itemId}, ${sql.json(row.wouldHave as never)}, ${row.reason}, ${now})`;
  }
}

export interface NudgeShadowOutcome {
  ran: boolean;
  caps: NudgeCapResult[];
}

/**
 * Runs the shadow pass for a published planning result. Never throws: the planning job must not fail
 * because an advisory log could not be written. Returns what it computed, for tests.
 */
export async function recordNudgeShadow(
  sql: Sql,
  userId: string,
  result: { recommendation?: unknown },
  now: Date = new Date()
): Promise<NudgeShadowOutcome> {
  const skipped: NudgeShadowOutcome = { ran: false, caps: [] };
  try {
    const [switchRow] = await sql<{ mode: string }[]>`
      SELECT mode FROM plan_map_switches WHERE user_id = ${userId} AND addon = ${ADDON}`;
    if (!switchRow || switchRow.mode === "off") return skipped;
    const links = await confirmedLinks(sql, userId);
    // Cheapest exit first: with no confirmed link there is nothing to nudge, so a run costs two queries.
    if (links.length === 0) return skipped;
    const [recent] = await sql<{ at: Date | null }[]>`
      SELECT max(created_at) AS at FROM plan_shadow_log WHERE user_id = ${userId} AND addon = ${ADDON}`;
    if (recent?.at && now.getTime() - new Date(recent.at).getTime() < NUDGE_MIN_INTERVAL_MINUTES * 60_000)
      return skipped;

    const triggers = await loadTriggers(sql, userId, now);
    if (triggers.length === 0) return skipped;

    const rawProjectIds = new Set<string>();
    for (const candidate of (result.recommendation as { candidates?: ResultCandidate[] })?.candidates ?? []) {
      if (candidate.action?.projectId) rawProjectIds.add(candidate.action.projectId);
    }
    const dueByProject = await projectDeadlines(sql, [...rawProjectIds]);
    const candidates = nudgeCandidatesFrom(result, dueByProject);
    const caps = computeNudge({ now, candidates, triggers, links, ordinaryRank: 1 });
    await logRun(sql, userId, crypto.randomUUID(), caps, now);
    return { ran: true, caps };
  } catch (error) {
    console.error("plan-map nudge shadow failed", error instanceof Error ? error.message : error);
    return skipped;
  }
}

/** The weekly comparison: per cap, what would have moved, whether it then got done, and whether anything due would have slipped. */
export async function readNudgeSummary(sql: Sql, userId: string, since: Date): Promise<NudgeCapSummary[]> {
  const rows = await sql<
    { item_type: string; item_id: string; would_have: Record<string, unknown>; created_at: Date }[]
  >`
    SELECT item_type, item_id, would_have, created_at FROM plan_shadow_log
    WHERE user_id = ${userId} AND addon = ${ADDON} AND created_at >= ${since}`;

  const moved = new Map<number, Map<string, { first: Date; gained: number }>>();
  const displaced = new Map<number, Map<string, boolean>>();
  const runs = new Map<number, number>();
  for (const row of rows) {
    const capDays = Number(row.would_have.capDays);
    const action = row.would_have.action;
    const handle = planNudgeHandle(row.item_type, row.item_id);
    if (action === "run") runs.set(capDays, (runs.get(capDays) ?? 0) + 1);
    if (action === "boost") {
      const map = moved.get(capDays) ?? new Map();
      const entry = map.get(handle) ?? { first: new Date(row.created_at), gained: 0 };
      entry.gained += Number(row.would_have.rankBefore) - Number(row.would_have.rankAfter);
      map.set(handle, entry);
      moved.set(capDays, map);
    }
    if (action === "displaced") {
      const map = displaced.get(capDays) ?? new Map();
      map.set(handle, (map.get(handle) ?? false) || row.would_have.dueWithinHorizon === true);
      displaced.set(capDays, map);
    }
  }

  const movedIds = new Set<string>();
  for (const map of moved.values()) for (const handle of map.keys()) movedIds.add(handle);
  const actionIds = [...movedIds].filter((h) => h.startsWith("action:")).map((h) => h.slice("action:".length));
  const deliverableIds = [...movedIds]
    .filter((h) => h.startsWith("deliverable:"))
    .map((h) => h.slice("deliverable:".length));
  const doneActions = actionIds.length
    ? await sql<{ id: string; at: Date | null }[]>`
        SELECT id::text AS id, updated_at AS at FROM actions WHERE id::text IN (SELECT jsonb_array_elements_text(${sql.json(actionIds as never)})) AND status = 'done'`
    : [];
  const doneDeliverables = deliverableIds.length
    ? await sql<{ id: string; at: Date | null }[]>`
        SELECT id::text AS id, updated_at AS at FROM deliverables WHERE id::text IN (SELECT jsonb_array_elements_text(${sql.json(deliverableIds as never)})) AND status = 'completed'`
    : [];
  const doneAt = new Map<string, Date | null>([
    ...doneActions.map((row) => [planNudgeHandle("action", row.id), row.at] as const),
    ...doneDeliverables.map((row) => [planNudgeHandle("deliverable", row.id), row.at] as const)
  ]);

  return NUDGE_CAPS_DAYS.map((capDays: NudgeCapDays) => {
    const movedHere = moved.get(capDays) ?? new Map();
    const slips = displaced.get(capDays) ?? new Map();
    return {
      capDays,
      runs: runs.get(capDays) ?? 0,
      actionsMoved: movedHere.size,
      placesGained: [...movedHere.values()].reduce((sum, entry) => sum + entry.gained, 0),
      movedThenDone: [...movedHere.entries()].filter(([handle, entry]) => {
        const at = doneAt.get(handle);
        return doneAt.has(handle) && (!at || new Date(at) >= entry.first);
      }).length,
      displaced: slips.size,
      slippedDue: [...slips.values()].filter(Boolean).length
    };
  });
}
