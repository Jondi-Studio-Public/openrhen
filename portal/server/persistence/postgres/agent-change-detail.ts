import { planForecastResponseSchema, type PlanForecastResponse } from "@openrhen/contracts";
import { diffDayPlans, type PlanChangeSummary } from "@/features/planning/plan-diff";
import { localDayKey } from "@/features/today/today-view";
import type { SnapshotRow } from "./write-snapshot";
import type { Sql } from "./sql-pool";

/**
 * One agent write explained for the owner (`GET /api/agent-changes/[id]`): per entity what changed (before to after),
 * the basis and quoted words the agent gave, and what the plan did afterwards. Read-only. The fields come from the
 * write's stored row images (`writes.images`, DB snake_case columns); a write with no image (a plain save, or one
 * past the snapshot limit) falls back to the before values `write_rows.evidence` kept, with the after unknown,
 * because reading the entity now could show a later edit as this write's.
 */
export interface AgentChangeField {
  field: string;
  before: unknown;
  /** Null when `afterKnown` is false. */
  after: unknown;
  /** False when only the before values were recorded. */
  afterKnown: boolean;
}

export interface AgentChangeRow {
  entityType: string;
  entityId: string | null;
  title: string | null;
  operation: string;
  fields: AgentChangeField[];
  basis: string | null;
  statedEvidence: string | null;
}

export interface AgentChangeDetail {
  writeId: string;
  actor: string | null;
  commandType: string;
  kind: string | null;
  at: string;
  state: "applied" | "undone" | null;
  rows: AgentChangeRow[];
  plan: PlanEffect;
}

/**
 * What the plan did after the write. `available` is false whenever `reason` is set: `pending` (the recalculation for
 * this write has not landed and the write is under {@link PENDING_WINDOW_MS} old, so check back), `pruned` (the run
 * before it, or the run for its input, is no longer kept) or `unknown` (the write recorded no input version, a stored
 * run does not parse, or the read failed). `pending` repeats `reason === "pending"`. Both are null/false when available.
 */
export interface PlanEffect extends PlanChangeSummary {
  dayKey: string | null;
  pending: boolean;
  reason: "pending" | "pruned" | "unknown" | null;
}

/** A write younger than this with no matching recalculation yet is still waiting for it; older, the run is gone. */
export const PENDING_WINDOW_MS = 60 * 60_000;

/**
 * Columns never shown as a change, for every table: identity and ownership (`id`, `user_id`), the optimistic-lock
 * counter and row timestamps (`version`, `created_at`, `updated_at`), and `*_recorded_at` bookkeeping stamps.
 */
export const NOISE_COLUMNS: readonly string[] = ["id", "user_id", "version", "created_at", "updated_at"];

export function isNoiseColumn(column: string): boolean {
  return NOISE_COLUMNS.includes(column) || column.endsWith("_recorded_at");
}

const words = (list: string) => list.split(/\s+/).filter(Boolean);

/**
 * The person-facing columns of the tables agents commonly write (DB column names, as `writes.images` stores them).
 * Anything else on these tables is engine bookkeeping (forecast_*, baseline_*, completion ratios, recommendation_id,
 * plan_sanction, last_worked_at, `planned`/`pending` flags and the like) and is never shown.
 */
export const VISIBLE_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries({
    commitments:
      "title starts_at ends_at status location location_id presence blocking project_id attendance in_person preferred_location_id transport_mode lateness_matters contact_id private check_in_extra_minutes freed_from",
    commitment_recurrence_rules:
      "title start_date end_date interval_unit days interval_days interval_months interval_weeks weekdays local_start_time local_end_time location location_id presence blocking status project_id transport_mode private check_in_extra_minutes",
    actions:
      "project_id title scheduling_mode one_off notes status expected_minutes remaining_minutes energy minimum_session_minutes maximum_session_minutes splittable available_from deadline_at importance consequence setup_minutes deliverable_id required completion_condition private prep_for_commitment_id",
    action_recurrence_rules:
      "action_id start_date end_date interval_days target_total_minutes period_unit period_length target_occurrences min_spacing_days eligible_weekdays",
    projects:
      "outcome_id title status external_deadline_at internal_deadline_at uncertainty consequence remaining_effort_override_minutes private",
    outcomes: "area_id title definition_of_done value status deadline_at review_on",
    deliverables:
      "project_id title details status external_deadline_at internal_deadline_at uncertainty importance consequence completion_threshold approval_note private",
    areas: "name description status review_interval_days private",
    // A mail mark: the kind and its closed attrs (fact id, status, valid_from, expires_at, act, basis, the owner's words).
    activity_events: "kind attrs",
    sessions:
      "action_id target_title status planned_started_at planned_end_at planned_minutes result_note override_reason",
    check_in: "slot_at directive_title status deviation_category deviation_note",
    sleep_plans: "planned_start_at planned_wake_at desired_minutes status actual_start_at actual_wake_at",
    routine_steps: "title purpose duration_minutes sequence energy phase status wait_after_minutes",
    spans: "title start_date end_date project_id",
    captures: "proposal_type status proposed_fields",
    daily_plans: "local_date horizon_override_at recovery_skipped",
    user_preferences:
      "planning_horizon_end current_horizon_end_at current_energy default_usable_fraction default_setup_buffer_minutes default_transition_buffer_minutes current_situation home_location_id preferred_bedtime preferred_wake_time desired_sleep_minutes minimum_sleep_minutes max_awake_hours recovery_start_time recovery_end_time recovery_weekdays default_transport_mode leave_by_lead_minutes calendar_share_enabled start_by_warning_minutes session_break_minutes arrival_margin_minutes pulse_unknown_to_off_minutes pulse_further_prompts pulse_unknown_hard_off_minutes"
  }).map(([table, list]) => [table, new Set(words(list))])
);

/** Engine-ish column names for a table with no allowlist. */
const ENGINE_COLUMN =
  /^(forecast_|baseline_|actual_|required_|recommendation|plan_|sanction|input_|score_|hard_|last_|completed_|confirmed_|resolved_|reviewed_|landed_)|_(hash|version|sanction)$/;

/**
 * Whether a column is shown. A table on the allowlist shows exactly its listed columns. Any other table shows
 * everything except noise, every `*_id` column (a bare uuid means nothing to a person), and engine-ish names.
 */
export function isShownColumn(table: string | null, column: string): boolean {
  if (isNoiseColumn(column)) return false;
  const allowed = table ? VISIBLE_COLUMNS[table] : undefined;
  if (allowed) return allowed.has(column);
  return !column.endsWith("_id") && !ENGINE_COLUMN.test(column);
}

/** Ledger `entity_type` to the table its fields are filtered by (the allowlist's key). */
export const ENTITY_TABLES: Readonly<Record<string, string>> = {
  commitment: "commitments",
  fixed_commitment: "commitments",
  commitment_recurrence_rule: "commitment_recurrence_rules",
  fixed_commitment_recurrence: "commitment_recurrence_rules",
  action: "actions",
  project: "projects",
  outcome: "outcomes",
  deliverable: "deliverables",
  area: "areas",
  check_in: "check_in",
  routine_step: "routine_steps",
  span: "spans",
  sleep_plan: "sleep_plans",
  settings: "user_preferences",
  planning_focus: "daily_plans"
};

/** Where an id column's name lives: a fixed map, the only table and column names ever put into SQL. */
const ID_SOURCES: Readonly<
  Record<string, { thing: string; table: string; nameColumn: string; userScoped: boolean; uuid: boolean }>
> = {
  location_id: { thing: "place", table: "condition_definitions", nameColumn: "name", userScoped: true, uuid: false },
  home_location_id: {
    thing: "place",
    table: "condition_definitions",
    nameColumn: "name",
    userScoped: true,
    uuid: false
  },
  preferred_location_id: {
    thing: "place",
    table: "condition_definitions",
    nameColumn: "name",
    userScoped: true,
    uuid: false
  },
  contact_id: { thing: "contact", table: "condition_definitions", nameColumn: "name", userScoped: true, uuid: false },
  project_id: { thing: "project", table: "projects", nameColumn: "title", userScoped: false, uuid: true },
  outcome_id: { thing: "outcome", table: "outcomes", nameColumn: "title", userScoped: false, uuid: true },
  area_id: { thing: "area", table: "areas", nameColumn: "name", userScoped: true, uuid: true },
  action_id: { thing: "action", table: "actions", nameColumn: "title", userScoped: false, uuid: true },
  deliverable_id: { thing: "deliverable", table: "deliverables", nameColumn: "title", userScoped: false, uuid: true },
  prep_for_commitment_id: {
    thing: "commitment",
    table: "commitments",
    nameColumn: "title",
    userScoped: true,
    uuid: true
  }
};

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every shown column whose value differs between the two images; a missing side (create, delete) counts as null. */
export function diffImages(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  table: string | null = null
): AgentChangeField[] {
  const columns = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const fields: AgentChangeField[] = [];
  for (const field of [...columns].sort()) {
    if (!isShownColumn(table, field)) continue;
    const was = before?.[field] ?? null;
    const now = after?.[field] ?? null;
    if (!same(was, now)) fields.push({ field, before: was, after: now, afterKnown: true });
  }
  return fields;
}

/** The fields of a write with no image: the before values recorded in the evidence, the after unknown. */
export function fieldsFromEvidence(evidence: Record<string, unknown>, table: string | null = null): AgentChangeField[] {
  const before = evidence.before;
  if (!before || typeof before !== "object" || Array.isArray(before)) return [];
  return Object.entries(before as Record<string, unknown>)
    .filter(([field]) => isShownColumn(table, snake(field)))
    .map(([field, value]) => ({ field, before: value ?? null, after: null, afterKnown: false }));
}

/** A row's own name: its `title`, else `name`, else `label`, from the after image, else the before. */
export function pickTitle(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string | null {
  for (const image of [after, before])
    for (const key of ["title", "name", "label"]) {
      const value = image?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  return null;
}

/** The action a row hangs off (sessions, check-ins), for naming it when it has no title of its own. */
export function actionIdOf(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string | null {
  const value = after?.action_id ?? before?.action_id;
  return typeof value === "string" ? value : null;
}

export interface LedgerRow {
  entityType: string;
  entityId: string | null;
  operation: string;
  evidence: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * A write states its basis once, but the ledger keeps it on some rows only (a capture confirm records it on the rows
 * that have a before-image; a created record's row, and any row whose quote is withheld, has none). Rows without a
 * basis take the write's, from the first row that has one; the same for the quoted words. `write_rows` is not
 * changed: a withheld quote (mail text) stays on no row and so is never shared here.
 */
export function shareBasis<T extends { basis: string | null; statedEvidence: string | null }>(rows: T[]): T[] {
  const basis = rows.find((row) => row.basis)?.basis ?? null;
  const statedEvidence = rows.find((row) => row.statedEvidence)?.statedEvidence ?? null;
  return rows.map((row) => ({
    ...row,
    basis: row.basis ?? basis,
    statedEvidence: row.statedEvidence ?? statedEvidence
  }));
}

/**
 * Joins the ledger rows to the stored images (an image belongs to the row whose `entity_id` is its key; ids are
 * uuids or JSON key arrays, so they do not collide across tables). Images no row names still appear, typed by their
 * table. Titles are not looked up here.
 */
export function buildRows(
  ledger: readonly LedgerRow[],
  images: readonly SnapshotRow[]
): Array<AgentChangeRow & { actionId: string | null; table: string | null }> {
  const used = new Set<SnapshotRow>();
  const rows: Array<AgentChangeRow & { actionId: string | null; table: string | null }> = [];
  for (const row of ledger) {
    const image = row.entityId === null ? undefined : images.find((candidate) => candidate.id === row.entityId);
    if (image) used.add(image);
    rows.push({
      entityType: row.entityType,
      entityId: row.entityId,
      title: image ? pickTitle(image.before, image.after) : null,
      operation: row.operation,
      fields: image
        ? diffImages(image.before, image.after, image.table)
        : fieldsFromEvidence(row.evidence, ENTITY_TABLES[row.entityType] ?? null),
      basis: text(row.evidence.basis),
      statedEvidence: text(row.evidence.statedEvidence),
      actionId: image ? actionIdOf(image.before, image.after) : null,
      table: image ? image.table : null
    });
  }
  for (const image of images) {
    if (used.has(image)) continue;
    rows.push({
      entityType: image.table,
      entityId: image.id,
      title: pickTitle(image.before, image.after),
      operation: image.before === null ? "create" : image.after === null ? "delete" : "save",
      fields: diffImages(image.before, image.after, image.table),
      basis: null,
      statedEvidence: null,
      actionId: actionIdOf(image.before, image.after),
      table: image.table
    });
  }
  return shareBasis(rows);
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NameSource {
  table: string;
  nameColumn: string;
  userScoped: boolean;
  uuid: boolean;
}

/** Tables whose rows have a title or name to show, by table. Fixed: the only identifiers ever put into SQL. */
const NAME_SOURCES: Readonly<Record<string, NameSource>> = {
  commitments: { table: "commitments", nameColumn: "title", userScoped: true, uuid: true },
  actions: { table: "actions", nameColumn: "title", userScoped: false, uuid: true },
  projects: { table: "projects", nameColumn: "title", userScoped: false, uuid: true },
  outcomes: { table: "outcomes", nameColumn: "title", userScoped: false, uuid: true },
  deliverables: { table: "deliverables", nameColumn: "title", userScoped: false, uuid: true },
  areas: { table: "areas", nameColumn: "name", userScoped: true, uuid: true },
  condition_definitions: { table: "condition_definitions", nameColumn: "name", userScoped: true, uuid: false }
};

/** Names of rows by id from one fixed table; ids that are not the table's key shape are skipped, never queried. */
async function namesOf(
  sql: Sql,
  userId: string,
  source: NameSource,
  ids: readonly string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const valid = [...new Set(ids)].filter((id) =>
    source.uuid ? UUID_SHAPE.test(id) : id.length > 0 && id.length <= 200
  );
  if (!valid.length) return found;
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id::text AS id, ${sql(source.nameColumn)} AS name FROM ${sql(source.table)}
    WHERE id::text IN ${sql(valid)} ${source.userScoped ? sql`AND user_id=${userId}` : sql``}`;
  for (const row of rows) found.set(row.id, row.name);
  return found;
}

type DetailRow = AgentChangeRow & { actionId: string | null; table: string | null };

/** The row's own table for title lookup: an image table, or the ledger entity type's table. */
function sourceOf(row: DetailRow): NameSource | undefined {
  const table = row.table ?? ENTITY_TABLES[row.entityType] ?? row.entityType;
  return NAME_SOURCES[table];
}

async function fillTitles(sql: Sql, userId: string, rows: DetailRow[]): Promise<AgentChangeRow[]> {
  // Rows with an action and no title of their own name that action; rows with no image, their own table's title.
  const actionTitles = await namesOf(
    sql,
    userId,
    NAME_SOURCES.actions!,
    rows.filter((row) => !row.title && row.actionId).map((row) => row.actionId!)
  );
  const ownIds = new Map<string, string[]>();
  for (const row of rows) {
    const source = sourceOf(row);
    if (!row.title && !row.actionId && source && row.entityId)
      ownIds.set(source.table, [...(ownIds.get(source.table) ?? []), row.entityId]);
  }
  const own = new Map<string, Map<string, string>>();
  for (const [table, ids] of ownIds) own.set(table, await namesOf(sql, userId, NAME_SOURCES[table]!, ids));
  return rows.map(({ actionId, table: _table, ...row }) => {
    if (row.title) return row;
    if (actionId) return { ...row, title: actionTitles.get(actionId) ?? null };
    const source = sourceOf({ ...row, actionId, table: _table });
    return { ...row, title: (source && row.entityId && own.get(source.table)?.get(row.entityId)) || null };
  });
}

/**
 * Replaces the id in each allowed id column (`location_id`, `project_id`, `outcome_id`, `area_id`, `action_id`,
 * `deliverable_id` and the like) with the name it points at, keeping the field name. An id whose row is gone (or not
 * this user's) comes out as "a removed <thing>" (for example "a removed project"), never as a bare uuid.
 */
export function resolveIdFields(
  fields: AgentChangeField[],
  names: ReadonlyMap<string, Map<string, string>>
): AgentChangeField[] {
  const swap = (field: string, value: unknown) => {
    const source = ID_SOURCES[snake(field)];
    if (!source || typeof value !== "string") return value;
    return names.get(source.table + "." + snake(field))?.get(value) ?? `a removed ${source.thing}`;
  };
  return fields.map((f) => ({ ...f, before: swap(f.field, f.before), after: swap(f.field, f.after) }));
}

async function resolveRowIds(sql: Sql, userId: string, rows: AgentChangeRow[]): Promise<AgentChangeRow[]> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows)
    for (const f of row.fields) {
      const source = ID_SOURCES[snake(f.field)];
      if (!source) continue;
      for (const value of [f.before, f.after])
        if (typeof value === "string") {
          const key = source.table + "." + snake(f.field);
          wanted.set(key, (wanted.get(key) ?? new Set()).add(value));
        }
    }
  const names = new Map<string, Map<string, string>>();
  for (const [key, ids] of wanted)
    names.set(key, await namesOf(sql, userId, NAME_SOURCES[ID_SOURCES[key.split(".")[1]!]!.table]!, [...ids]));
  return rows.map((row) => ({ ...row, fields: resolveIdFields(row.fields, names) }));
}

export function unavailablePlan(
  dayKey: string | null,
  reason: NonNullable<PlanEffect["reason"]> = "unknown"
): PlanEffect {
  return {
    available: false,
    moved: [],
    dropped: [],
    added: [],
    sleepShiftMinutes: 0,
    beforeNightPlannedStartAt: null,
    newlyDisplaced: [],
    dayKey,
    pending: reason === "pending",
    reason
  };
}

/** Why a plan effect is unavailable, from what was found; pure so the rule is tested without a database. */
export function missingPlanReason(found: {
  before: boolean;
  after: boolean;
  hasInputVersion: boolean;
  ageMs: number;
}): NonNullable<PlanEffect["reason"]> {
  if (!found.hasInputVersion) return "unknown";
  // No run before the write is either pruned history or the person's very first write; those cannot be told apart.
  if (!found.before) return "unknown";
  if (!found.after) return found.ageMs < PENDING_WINDOW_MS ? "pending" : "pruned";
  return "unknown";
}

function parseRun(result: unknown): PlanForecastResponse | undefined {
  const parsed = planForecastResponseSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The plan before and after the write. Before: the newest run calculated at or before the write. After: the oldest
 * run calculated after the write whose `planning_runs.input_version` equals the `inputVersion` the write's last
 * ledger row recorded. There is deliberately no fallback to "the next run": it can carry later edits, which would be
 * blamed on this write. No such run yet is `pending` (see {@link missingPlanReason}).
 */
async function planEffect(
  sql: Sql,
  userId: string,
  at: Date,
  inputVersion: string | null,
  timezone: string | null,
  now: Date
): Promise<PlanEffect> {
  if (!timezone) return unavailablePlan(null);
  const dayKey = localDayKey(at, timezone);
  try {
    const beforeRows = await sql<{ result: unknown }[]>`
      SELECT result FROM planning_runs WHERE user_id=${userId} AND calculated_at <= ${at}
      ORDER BY calculated_at DESC LIMIT 1`;
    const afterRows = inputVersion
      ? await sql<{ result: unknown }[]>`
          SELECT result FROM planning_runs WHERE user_id=${userId} AND calculated_at > ${at} AND input_version=${inputVersion}
          ORDER BY calculated_at ASC LIMIT 1`
      : [];
    const before = beforeRows[0] ? parseRun(beforeRows[0].result) : undefined;
    const after = afterRows[0] ? parseRun(afterRows[0].result) : undefined;
    const summary = diffDayPlans(before, after, { dayKey, timezone });
    if (summary.available) return { ...summary, dayKey, pending: false, reason: null };
    const reason = missingPlanReason({
      before: beforeRows.length > 0,
      after: afterRows.length > 0,
      hasInputVersion: inputVersion !== null,
      ageMs: now.getTime() - at.getTime()
    });
    return unavailablePlan(dayKey, reason);
  } catch {
    return unavailablePlan(dayKey);
  }
}

/** One write explained, or null when this user has no such write. */
export async function readAgentChangeDetail(
  sql: Sql,
  userId: string,
  writeId: string
): Promise<AgentChangeDetail | null> {
  const writes = await sql<
    {
      id: string;
      actor: string | null;
      command_type: string;
      kind: string | null;
      state: "applied" | "undone" | null;
      images: SnapshotRow[] | null;
      response: unknown;
      created_at: Date;
    }[]
  >`SELECT id, actor, command_type, kind, state, images, response, created_at FROM writes WHERE id=${writeId} AND user_id=${userId}`;
  const write = writes[0];
  if (!write) return null;
  // A changeset keeps no rows of its own: what it changed is its members' writes, each with its own records and basis.
  const members =
    write.command_type === "changeset"
      ? (((write.response as { members?: unknown } | null)?.members as unknown[] | undefined)?.filter(
          (member): member is string => typeof member === "string"
        ) ?? [])
      : [];
  const parts =
    members.length === 0
      ? [{ id: write.id, images: write.images }]
      : (
          await sql<{ id: string; images: SnapshotRow[] | null }[]>`
            SELECT id, images FROM writes WHERE id::text IN ${sql(members)} AND user_id=${userId}`
        ).sort((a, b) => members.indexOf(a.id) - members.indexOf(b.id));
  const ids = parts.map((part) => part.id);
  const ledger = await sql<
    {
      write_id: string;
      entity_type: string;
      entity_id: string | null;
      operation: string;
      evidence: Record<string, unknown> | null;
    }[]
  >`SELECT write_id, entity_type, entity_id, operation, evidence FROM write_rows WHERE write_id::text IN ${sql(ids)} AND user_id=${userId} ORDER BY created_at, id`;
  const users = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  const ledgerRows = ledger.map((row) => ({
    writeId: row.write_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    evidence: row.evidence ?? {}
  }));
  const inputVersion =
    [...ledgerRows]
      .reverse()
      .map((row) => text(row.evidence.inputVersion))
      .find(Boolean) ?? null;
  const built = parts.flatMap((part) =>
    buildRows(
      ledgerRows.filter((row) => row.writeId === part.id),
      Array.isArray(part.images) ? part.images : []
    )
  );
  const rows = await resolveRowIds(sql, userId, await fillTitles(sql, userId, built));
  return {
    writeId: write.id,
    actor: write.actor,
    commandType: write.command_type,
    kind: write.kind,
    at: write.created_at.toISOString(),
    state: write.state,
    rows,
    plan: await planEffect(sql, userId, write.created_at, inputVersion, users[0]?.timezone ?? null, new Date())
  };
}
