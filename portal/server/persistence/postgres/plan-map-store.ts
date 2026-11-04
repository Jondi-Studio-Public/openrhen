import {
  OWNER_PROPOSER,
  PLAN_LINK_SUGGESTION_TTL_DAYS,
  isOwnerProposer,
  SWITCHABLE_ADDONS,
  PLAN_SHADOW_LOG_RETENTION_DAYS,
  effectiveMode,
  openQuestionSchema,
  parseHandle,
  planFindingSchema,
  planLinkSchema,
  planSubjectSchema,
  unansweredQuestions,
  validateLink,
  type OpenQuestion,
  type PlanFinding,
  type PlanItemType,
  type PlanLink,
  type PlanLinkInput,
  type PlanLinkKind,
  type PlanMap,
  type PlanMapAddon,
  type PlanMapMode,
  type PlanSubject,
  type SwitchableAddon
} from "@openrhen/contracts";
import { planFindings, planLinks, planMapSwitches, planSubjects } from "@openrhen/database";
import { z } from "zod";
import type { Row } from "./db-row";
import { logProposerDecision } from "./plan-map-proposers";
import type { PoolSql, Sql } from "./sql-pool";

/**
 * Plan map link store: the tables `plan_subjects`,
 * `plan_links`, `plan_findings`, `plan_shadow_log` and `plan_map_switches`. Plain functions over a
 * `Sql` handle (each statement stands alone, so a pool or an open transaction both work). Link ends are
 * polymorphic with no foreign key, so existence is checked here on write and by `sweepPlanMap` daily.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The five subjects every user starts with (owner decision, 2026-10-01); migration 0100 seeds existing users. */
export const STARTING_PLAN_SUBJECTS: readonly { id: string; name: string }[] = [
  { id: "maths", name: "Maths" },
  { id: "drafting", name: "Drafting" },
  { id: "meals", name: "Meals" },
  { id: "exercise", name: "Exercise" },
  { id: "money", name: "Money" }
];

export async function seedStartingSubjects(sql: Sql, userId: string): Promise<void> {
  for (const subject of STARTING_PLAN_SUBJECTS) {
    await sql`
      INSERT INTO plan_subjects (user_id, id, name, status)
      VALUES (${userId}, ${subject.id}, ${subject.name}, 'active')
      ON CONFLICT (user_id, id) DO NOTHING
    `;
  }
}

/** Seeds the starting subjects only when the user has none at all, so an archived or renamed set stays as it is. */
export async function seedStartingSubjectsIfNone(sql: Sql, userId: string): Promise<void> {
  const [row] = await sql<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM plan_subjects WHERE user_id = ${userId}`;
  if (row?.count === "0") await seedStartingSubjects(sql, userId);
}

type LinkRow = Row<
  typeof planLinks,
  | "id"
  | "from_type"
  | "from_id"
  | "to_type"
  | "to_id"
  | "kind"
  | "weight"
  | "status"
  | "proposer"
  | "evidence"
  | "created_at"
  | "decided_at"
  | "last_confirmed_at"
>;

const LINK_COLUMNS = `id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at, decided_at, last_confirmed_at`;

function toLink(row: LinkRow): PlanLink {
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
    createdAt: iso(row.created_at),
    decidedAt: iso(row.decided_at),
    lastConfirmedAt: iso(row.last_confirmed_at)
  });
}

type FindingRow = Row<
  typeof planFindings,
  | "id"
  | "check_name"
  | "item_ids"
  | "text"
  | "evidence"
  | "suggested_changes"
  | "questions"
  | "status"
  | "created_at"
  | "decided_at"
>;

/**
 * `plan_findings.item_ids` stays jsonb (a finding is a point-in-time note, and a handle can name a slug or an
 * unprefixed id with no table to constrain it), so a deleted item cannot cascade out of it. The read drops
 * those handles instead: `staleHandles` is the set of `<type>:<id>` handles that parse as plan items and no
 * longer exist for the user. A handle that does not parse as a plan item (such as a bare commitment id) is
 * kept as stored.
 */
function toFinding(row: FindingRow, staleHandles: ReadonlySet<string> = new Set()): PlanFinding {
  const itemIds = Array.isArray(row.item_ids)
    ? row.item_ids.filter((handle) => typeof handle !== "string" || !staleHandles.has(handle))
    : row.item_ids;
  return planFindingSchema.parse({
    id: row.id,
    checkName: row.check_name,
    itemIds,
    text: row.text,
    evidence: row.evidence,
    suggestedChanges: row.suggested_changes,
    questions: row.questions,
    status: row.status,
    createdAt: iso(row.created_at),
    decidedAt: iso(row.decided_at)
  });
}

/**
 * Parses stored rows for a read, dropping any row the strict schema rejects instead of failing the
 * whole read: one bad row (say a proposer the schema no longer allows) must not hide every other
 * link and finding. Writes keep the strict schema. The warning names the row id and the zod
 * issue paths and codes only, never the row contents.
 */
export function parseStoredRows<Stored extends { id: string }, Parsed>(
  rows: readonly Stored[],
  parse: (row: Stored) => Parsed,
  table: "plan_links" | "plan_findings"
): Parsed[] {
  const parsed: Parsed[] = [];
  for (const row of rows) {
    try {
      parsed.push(parse(row));
    } catch (error) {
      const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Skipped a stored plan map row that failed validation",
          table,
          rowId: row.id,
          issue: issue ? `${issue.path.join(".") || "(row)"}: ${issue.code}` : "unparseable"
        })
      );
    }
  }
  return parsed;
}

/**
 * The handles in these findings whose target no longer exists, found with one `existingIds` query per item
 * type that appears (at most ten, none when no finding names an item).
 */
async function findStaleHandles(sql: Sql, userId: string, rows: readonly FindingRow[]): Promise<Set<string>> {
  const idsByType = new Map<PlanItemType, Set<string>>();
  for (const row of rows) {
    if (!Array.isArray(row.item_ids)) continue;
    for (const handle of row.item_ids) {
      const parsed = typeof handle === "string" ? parseHandle(handle) : null;
      if (!parsed) continue;
      const ids = idsByType.get(parsed.type) ?? new Set<string>();
      ids.add(parsed.id);
      idsByType.set(parsed.type, ids);
    }
  }
  const stale = new Set<string>();
  for (const [type, ids] of idsByType) {
    const live = await existingIds(sql, userId, type, [...ids]);
    for (const id of ids) if (!live.has(id)) stale.add(`${type}:${id}`);
  }
  return stale;
}

/** Subjects, links, findings and switches for one user; absent switch rows read as `off`. */
export async function listPlanMap(sql: Sql, userId: string): Promise<PlanMap> {
  const subjectRows = await sql<Row<typeof planSubjects, "id" | "name" | "description" | "status">[]>`
    SELECT id, name, description, status FROM plan_subjects WHERE user_id = ${userId} ORDER BY name, id
  `;
  const linkRows = await sql<LinkRow[]>`
    SELECT ${sql.unsafe(LINK_COLUMNS)} FROM plan_links WHERE user_id = ${userId} ORDER BY created_at, id
  `;
  const findingRows = await sql<FindingRow[]>`
    SELECT id, check_name, item_ids, text, evidence, suggested_changes, questions, status, created_at, decided_at
    FROM plan_findings WHERE user_id = ${userId} ORDER BY created_at, id
  `;
  const staleHandles = await findStaleHandles(sql, userId, findingRows);
  const switchRows = await sql<Row<typeof planMapSwitches, "addon" | "mode">[]>`
    SELECT addon, mode FROM plan_map_switches WHERE user_id = ${userId}
  `;
  const modes = new Map(switchRows.map((row) => [row.addon, row.mode]));
  return {
    subjects: subjectRows.map((row) => planSubjectSchema.parse(row) as PlanSubject),
    links: parseStoredRows(linkRows, toLink, "plan_links"),
    findings: parseStoredRows(findingRows, (row) => toFinding(row, staleHandles), "plan_findings"),
    switches: SWITCHABLE_ADDONS.map((addon) => ({ addon, mode: effectiveMode(addon, modes.get(addon)) }))
  };
}

/**
 * Which of `ids` still name a row of `type` for this user. Child tables carry no `user_id`, so each
 * is scoped through its parents. A commitment end may be an occurrence's rule (`commitment_recurrence_rules`)
 * or a one-off (`commitments`): a link on a recurring series points at the rule, never an occurrence.
 */
async function existingIds(sql: Sql, userId: string, type: PlanItemType, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const list = sql.json(ids as never);
  let rows: { id: string }[];
  switch (type) {
    case "area":
      rows =
        await sql`SELECT id::text AS id FROM areas WHERE user_id = ${userId} AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "outcome":
      rows = await sql`
        SELECT o.id::text AS id FROM outcomes o JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND o.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "project":
      rows = await sql`
        SELECT p.id::text AS id FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND p.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "deliverable":
      rows = await sql`
        SELECT d.id::text AS id FROM deliverables d JOIN projects p ON p.id = d.project_id
          JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND d.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "action":
      rows = await sql`
        SELECT x.id::text AS id FROM actions x JOIN projects p ON p.id = x.project_id
          JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND x.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "commitment":
      rows = await sql`
        SELECT id::text AS id FROM commitments WHERE user_id = ${userId} AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))
        UNION
        SELECT id::text AS id FROM commitment_recurrence_rules WHERE user_id = ${userId} AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "contact":
      rows = await sql`
        SELECT id FROM condition_definitions WHERE user_id = ${userId} AND kind = 'contact' AND id = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "place":
      rows = await sql`
        SELECT id FROM condition_definitions WHERE user_id = ${userId} AND kind = 'location' AND id = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "source":
      rows =
        await sql`SELECT id::text AS id FROM sources WHERE user_id = ${userId} AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
    case "subject":
      rows =
        await sql`SELECT id FROM plan_subjects WHERE user_id = ${userId} AND id = ANY(ARRAY(SELECT jsonb_array_elements_text(${list})))`;
      break;
  }
  return new Set(rows.map((row) => row.id));
}

export type CreateLinkResult =
  { ok: true; link: PlanLink } | { ok: false; code: "invalid_ends" | "missing_end" | "rejected_pair"; reason: string };

type LinkRefusal = { code: "invalid_ends" | "missing_end" | "rejected_pair"; reason: string };

/**
 * The checks a hand-made link must pass, shared by `createManualLink` and the `plan_link` import preview
 * so both refuse the same things: ends the kind does not allow (and a self link), ends that do not exist,
 * and a pair that was rejected. Returns null when the link may be made.
 */
export async function checkPlanLink(sql: Sql, userId: string, input: PlanLinkInput): Promise<LinkRefusal | null> {
  const ends = validateLink(input);
  if (!ends.ok) return { code: "invalid_ends", reason: ends.reason };
  for (const [type, id] of [
    [input.fromType, input.fromId],
    [input.toType, input.toId]
  ] as const) {
    if (!(await existingIds(sql, userId, type, [id])).has(id)) {
      return { code: "missing_end", reason: `No ${type} "${id}" exists.` };
    }
  }
  const rejected = await sql<{ id: string }[]>`
    SELECT id FROM plan_links
    WHERE user_id = ${userId} AND from_type = ${input.fromType} AND from_id = ${input.fromId}
      AND to_type = ${input.toType} AND to_id = ${input.toId} AND kind = ${input.kind} AND status = 'rejected'
  `;
  if (rejected[0]) {
    return { code: "rejected_pair", reason: "This pair was rejected; confirm it explicitly to revive it." };
  }
  return null;
}

/**
 * Links by hand: confirmed, proposer `owner`. Invalid ends (kind rules, self link) and ends that do not
 * exist are refused. A pair that is already confirmed comes back unchanged; a suggested or expired one
 * is confirmed in place. A rejected pair is refused: only an explicit `decideLink(..., "confirm")` revives it.
 */
export async function createManualLink(
  sql: Sql,
  userId: string,
  input: PlanLinkInput,
  now: Date = new Date()
): Promise<CreateLinkResult> {
  const refusal = await checkPlanLink(sql, userId, input);
  if (refusal) return { ok: false, ...refusal };
  const existing = await sql<LinkRow[]>`
    SELECT ${sql.unsafe(LINK_COLUMNS)} FROM plan_links
    WHERE user_id = ${userId} AND from_type = ${input.fromType} AND from_id = ${input.fromId}
      AND to_type = ${input.toType} AND to_id = ${input.toId} AND kind = ${input.kind}
  `;
  const found = existing[0];
  if (found?.status === "confirmed") return { ok: true, link: toLink(found) };
  if (found) {
    const updated = await sql<LinkRow[]>`
      UPDATE plan_links SET status = 'confirmed', decided_at = ${now}, last_confirmed_at = ${now}
      WHERE id = ${found.id} AND user_id = ${userId}
      RETURNING ${sql.unsafe(LINK_COLUMNS)}
    `;
    const link = toLink(updated[0]!);
    if (found.status === "suggested" && !isOwnerProposer(link.proposer))
      await logProposerDecision(sql, userId, link, "accepted", now);
    return { ok: true, link };
  }
  const created = await sql<LinkRow[]>`
    INSERT INTO plan_links (user_id, from_type, from_id, to_type, to_id, kind, weight, status, proposer, evidence, created_at, decided_at, last_confirmed_at)
    VALUES (${userId}, ${input.fromType}, ${input.fromId}, ${input.toType}, ${input.toId}, ${input.kind},
      ${input.weight ?? null}, 'confirmed', ${OWNER_PROPOSER}, ${sql.json((input.evidence ?? []) as never)}, ${now}, ${now}, ${now})
    RETURNING ${sql.unsafe(LINK_COLUMNS)}
  `;
  return { ok: true, link: toLink(created[0]!) };
}

export type LinkDecision = "confirm" | "reject" | "remove" | "reopen";
export type DecideLinkResult =
  | { ok: true; link: PlanLink | null }
  | { ok: false; code: "not_found" | "rejected_kept" | "not_decided"; reason: string };

/**
 * Confirm (also revives a rejected or expired link), reject (kept, so the pair is never proposed
 * again), remove (deletes a confirmed, suggested or expired link; a rejected row is never removed,
 * since it is the memory that stops a re-proposal), or reopen (puts a confirmed or rejected suggestion
 * back to `suggested`, as the Inbox's Undo does). `link` is null after a remove.
 */
export async function decideLink(
  sql: PoolSql,
  userId: string,
  linkId: string,
  decision: LinkDecision,
  now: Date = new Date()
): Promise<DecideLinkResult> {
  if (decision === "reopen") return reopenLink(sql, userId, linkId);
  if (decision === "remove") {
    const current = await sql<
      Row<typeof planLinks, "status">[]
    >`SELECT status FROM plan_links WHERE id = ${linkId} AND user_id = ${userId}`;
    if (!current[0]) return { ok: false, code: "not_found", reason: "No such link." };
    if (current[0].status === "rejected") {
      return { ok: false, code: "rejected_kept", reason: "A rejected link is kept so it is not proposed again." };
    }
    await sql`DELETE FROM plan_links WHERE id = ${linkId} AND user_id = ${userId}`;
    return { ok: true, link: null };
  }
  // The decision and the proposer-rate row it logs land together, or neither does.
  return sql.begin(async (tx): Promise<DecideLinkResult> => {
    const before = await tx<
      { status: string; proposer: string }[]
    >`SELECT status, proposer FROM plan_links WHERE id = ${linkId} AND user_id = ${userId} FOR UPDATE`;
    const rows =
      decision === "confirm"
        ? await tx<LinkRow[]>`
            UPDATE plan_links SET status = 'confirmed', decided_at = ${now}, last_confirmed_at = ${now}
            WHERE id = ${linkId} AND user_id = ${userId} RETURNING ${tx.unsafe(LINK_COLUMNS)}`
        : await tx<LinkRow[]>`
            UPDATE plan_links SET status = 'rejected', decided_at = ${now}
            WHERE id = ${linkId} AND user_id = ${userId} RETURNING ${tx.unsafe(LINK_COLUMNS)}`;
    if (!rows[0]) return { ok: false, code: "not_found", reason: "No such link." };
    const link = toLink(rows[0]);
    // Only the first decision on a person-less suggestion counts toward a proposer's accept rate.
    if (before[0]?.status === "suggested" && !isOwnerProposer(link.proposer)) {
      await logProposerDecision(tx, userId, link, decision === "confirm" ? "accepted" : "rejected", now);
    }
    return { ok: true, link };
  });
}

/**
 * Undoes a decision on a suggestion: a confirmed or rejected link from a proposer goes back to `suggested`
 * with no decision time, and the accept or reject it logged for the proposer's rate is taken back so the
 * next decision counts once. A link made by hand (proposer `owner`) was never a suggestion, so it stays.
 */
async function reopenLink(sql: PoolSql, userId: string, linkId: string): Promise<DecideLinkResult> {
  // Reopened and its logged decision taken back together, so a failure cannot leave it counted twice.
  return sql.begin(async (tx): Promise<DecideLinkResult> => {
    const rows = await tx<LinkRow[]>`
      UPDATE plan_links SET status = 'suggested', decided_at = NULL, last_confirmed_at = NULL
      WHERE id = ${linkId} AND user_id = ${userId} AND status IN ('confirmed', 'rejected') AND proposer <> 'owner'
      RETURNING ${tx.unsafe(LINK_COLUMNS)}
    `;
    if (!rows[0]) {
      const current = await tx<
        { id: string }[]
      >`SELECT id FROM plan_links WHERE id = ${linkId} AND user_id = ${userId}`;
      if (!current[0]) return { ok: false, code: "not_found", reason: "No such link." };
      return { ok: false, code: "not_decided", reason: "That link is not a decided suggestion." };
    }
    await tx`
      DELETE FROM plan_shadow_log
      WHERE user_id = ${userId} AND run_id = 'decision' AND would_have->>'linkId' = ${linkId}
    `;
    return { ok: true, link: toLink(rows[0]) };
  });
}

/** Raised when a finding with open questions is accepted before every one has an answer. */
export class FindingQuestionsError extends Error {
  readonly code = "unanswered";
}

/**
 * Accept or dismiss a finding. Dismissed findings are kept so the same finding is not raised again.
 * A finding that asks questions (the shared open-question shape) is accepted only with an answer to each;
 * the answers are kept on its questions. Dismissing needs none.
 */
export async function decideFinding(
  sql: Sql,
  userId: string,
  findingId: string,
  decision: "accept" | "dismiss",
  now: Date = new Date(),
  answers: Record<string, string> = {}
): Promise<PlanFinding | null> {
  const status = decision === "accept" ? "accepted" : "dismissed";
  let questions: OpenQuestion[] | null = null;
  if (decision === "accept") {
    const current = await sql<Row<typeof planFindings, "questions">[]>`
      SELECT questions FROM plan_findings WHERE id = ${findingId} AND user_id = ${userId}
    `;
    if (!current[0]) return null;
    const stored = z.array(openQuestionSchema).safeParse(current[0].questions ?? []);
    const open = stored.success ? stored.data : [];
    const missing = unansweredQuestions(open, answers);
    if (missing.length) throw new FindingQuestionsError(`Answer "${missing[0]!.question}" before accepting.`);
    if (open.length)
      questions = open.map((question) => ({
        ...question,
        answer: (answers[question.field] ?? question.answer ?? "").trim()
      }));
  }
  const rows = questions
    ? await sql<FindingRow[]>`
        UPDATE plan_findings SET status = ${status}, decided_at = ${now}, questions = ${sql.json(questions as never)}
        WHERE id = ${findingId} AND user_id = ${userId}
        RETURNING id, check_name, item_ids, text, evidence, suggested_changes, questions, status, created_at, decided_at
      `
    : await sql<FindingRow[]>`
        UPDATE plan_findings SET status = ${status}, decided_at = ${now}
        WHERE id = ${findingId} AND user_id = ${userId}
        RETURNING id, check_name, item_ids, text, evidence, suggested_changes, questions, status, created_at, decided_at
      `;
  return rows[0] ? toFinding(rows[0], await findStaleHandles(sql, userId, rows)) : null;
}

export type ReopenFindingResult =
  { ok: true; finding: PlanFinding } | { ok: false; code: "not_found" | "not_decided"; reason: string };

/** Puts an accepted or dismissed finding back to `open`, as the Inbox's Undo does. */
export async function reopenFinding(sql: Sql, userId: string, findingId: string): Promise<ReopenFindingResult> {
  const rows = await sql<FindingRow[]>`
    UPDATE plan_findings SET status = 'open', decided_at = NULL
    WHERE id = ${findingId} AND user_id = ${userId} AND status IN ('accepted', 'dismissed')
    RETURNING id, check_name, item_ids, text, evidence, suggested_changes, questions, status, created_at, decided_at
  `;
  if (rows[0]) return { ok: true, finding: toFinding(rows[0], await findStaleHandles(sql, userId, rows)) };
  const current = await sql<
    { id: string }[]
  >`SELECT id FROM plan_findings WHERE id = ${findingId} AND user_id = ${userId}`;
  return current[0]
    ? { ok: false, code: "not_decided", reason: "That finding is not decided." }
    : { ok: false, code: "not_found", reason: "No such finding." };
}

/** Confirms every still-suggested link from `proposer` of `kind`. Returns the ids confirmed, so Undo can reopen them. */
export async function bulkConfirm(
  sql: PoolSql,
  userId: string,
  proposer: string,
  kind: PlanLinkKind,
  now: Date = new Date()
): Promise<string[]> {
  return sql.begin(async (tx) => {
    const rows = await tx<LinkRow[]>`
      UPDATE plan_links SET status = 'confirmed', decided_at = ${now}, last_confirmed_at = ${now}
      WHERE user_id = ${userId} AND status = 'suggested' AND proposer = ${proposer} AND kind = ${kind}
      RETURNING ${tx.unsafe(LINK_COLUMNS)}
    `;
    if (!isOwnerProposer(proposer)) {
      for (const row of rows) await logProposerDecision(tx, userId, toLink(row), "accepted", now);
    }
    return rows.map((row) => row.id);
  });
}

/** One add-on's effective mode for one user (`effectiveMode`); an absent row reads as `off`. */
export async function getSwitchMode(sql: Sql, userId: string, addon: PlanMapAddon): Promise<PlanMapMode> {
  const rows = await sql<Row<typeof planMapSwitches, "mode">[]>`
    SELECT mode FROM plan_map_switches WHERE user_id = ${userId} AND addon = ${addon}
  `;
  return effectiveMode(addon, rows[0]?.mode);
}

/** One add-on's effective mode, or null when the person never set it (so an env fallback can apply). */
export async function findSwitchMode(sql: Sql, userId: string, addon: PlanMapAddon): Promise<PlanMapMode | null> {
  const rows = await sql<Row<typeof planMapSwitches, "mode">[]>`
    SELECT mode FROM plan_map_switches WHERE user_id = ${userId} AND addon = ${addon}
  `;
  return rows[0] ? effectiveMode(addon, rows[0].mode) : null;
}

/** Sets one add-on's mode. Only the person calls this with `on`; nothing here promotes automatically. */
export async function setSwitch(
  sql: Sql,
  userId: string,
  addon: SwitchableAddon,
  mode: PlanMapMode,
  now: Date = new Date()
): Promise<void> {
  await sql`
    INSERT INTO plan_map_switches (user_id, addon, mode, updated_at)
    VALUES (${userId}, ${addon}, ${mode}, ${now})
    ON CONFLICT (user_id, addon) DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at
  `;
}

export interface PlanMapSweepCounts {
  /** Links deleted because an end no longer exists. */
  orphanedLinksDeleted: number;
  /** Suggestions older than 30 days marked `expired`. */
  suggestionsExpired: number;
  /** `plan_shadow_log` rows older than 60 days deleted. */
  shadowRowsDeleted: number;
}

/**
 * The daily sweep for one user. A link whose from or to no longer exists is deleted (rejected rows
 * included: a pair that cannot be proposed again needs no memory), suggestions undecided for over 30 days
 * expire, and shadow-log rows older than 60 days are pruned.
 */
export async function sweepPlanMap(sql: Sql, userId: string, now: Date = new Date()): Promise<PlanMapSweepCounts> {
  const links = await sql<
    (Row<typeof planLinks, "id" | "from_type" | "from_id" | "to_type" | "to_id"> & {
      // Narrowed from `text`: link ends are written only through `validateLink`, so only item types occur.
      from_type: PlanItemType;
      to_type: PlanItemType;
    })[]
  >`
    SELECT id, from_type, from_id, to_type, to_id FROM plan_links WHERE user_id = ${userId}
  `;
  const idsByType = new Map<PlanItemType, Set<string>>();
  for (const link of links) {
    for (const [type, id] of [
      [link.from_type, link.from_id],
      [link.to_type, link.to_id]
    ] as const) {
      const set = idsByType.get(type) ?? new Set<string>();
      set.add(id);
      idsByType.set(type, set);
    }
  }
  const alive = new Map<PlanItemType, Set<string>>();
  for (const [type, ids] of idsByType) alive.set(type, await existingIds(sql, userId, type, [...ids]));
  const orphaned = links
    .filter((link) => !alive.get(link.from_type)!.has(link.from_id) || !alive.get(link.to_type)!.has(link.to_id))
    .map((link) => link.id);
  if (orphaned.length > 0) {
    await sql`DELETE FROM plan_links WHERE user_id = ${userId} AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${sql.json(orphaned as never)})))`;
  }
  const expired = await sql<{ id: string }[]>`
    UPDATE plan_links SET status = 'expired'
    WHERE user_id = ${userId} AND status = 'suggested'
      AND created_at < ${new Date(now.getTime() - PLAN_LINK_SUGGESTION_TTL_DAYS * DAY_MS)}
    RETURNING id
  `;
  const shadow = await sql<{ id: string }[]>`
    DELETE FROM plan_shadow_log
    WHERE user_id = ${userId} AND created_at < ${new Date(now.getTime() - PLAN_SHADOW_LOG_RETENTION_DAYS * DAY_MS)}
    RETURNING id
  `;
  return {
    orphanedLinksDeleted: orphaned.length,
    suggestionsExpired: expired.length,
    shadowRowsDeleted: shadow.length
  };
}
