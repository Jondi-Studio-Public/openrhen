import { requestAgent } from "@/server/agent-actor";
import { holdPlanForecastPublication } from "./planning-evidence";
import type { Sql } from "./sql-pool";

/**
 * Row snapshots of an agent's write, so the write can be undone afterwards and redone (the design notes,
 * "Undo after"). The CLI journals most writes by restating the record as it was; a session, check-in, catch-up or
 * Inbox-confirm write changes several rows in ways no restating command can put back, so the server keeps the rows
 * themselves: each row the write touched, as it was before and as the write left it, keyed by the write's `commandId`.
 * `POST /api/commands/revert` puts the before-images back only while every row still equals its after-image, so an
 * edit made since is never overwritten.
 *
 * Only an agent's write is snapshotted (`requestAgent()`); the person's own writes are not undone from a journal.
 */

/**
 * The core tables a snapshot may hold, in the order a restore inserts them (parents first); deletes run in reverse.
 * A feature the OpenRhen export leaves out adds its own through `registerSnapshotTable`; `SNAPSHOT_TABLES` below is the
 * core list plus those.
 */
export const CORE_SNAPSHOT_TABLES = [
  "users",
  "sources",
  "captures",
  "areas",
  "user_preferences",
  "routine_presets",
  "outcomes",
  "projects",
  "commitment_recurrence_rules",
  "commitments",
  // After the commitments they point at (`commitment_id`, ON DELETE SET NULL / CASCADE), so a restore inserts
  // the commitment first and then relinks or re-inserts these.
  "condition_definitions",
  "calendar_event_links",
  "deliverables",
  "actions",
  "action_recurrence_rules",
  "action_recurrence_windows",
  "routine_preset_steps",
  "routine_preset_step_dependencies",
  "spans",
  "sleep_plans",
  "routine_steps",
  "routine_step_dependencies",
  "planning_focus_periods",
  "planning_focus_projects",
  "daily_plans",
  "daily_plan_desired_actions",
  "daily_plan_deferred_actions",
  "action_requirement_pathways",
  "action_requirements",
  "action_preferences",
  "action_dependencies",
  "deliverable_dependencies",
  "deliverable_sources",
  // A deliverable save's contract and blockers: after the deliverable they belong to, and the links to the steps
  // (actions) after both ends.
  "deliverable_criteria",
  "deliverable_blockers",
  "deliverable_criterion_actions",
  "deliverable_blocker_actions",
  "action_occurrences",
  "sessions",
  "session_segments",
  "action_cadence_completions",
  "check_in",
  "catch_up_runs",
  "entity_prerequisites",
  "journey_samples",
  "pulse_segments",
  "pulse_state",
  "pulse_disruptions"
] as const;
export type CoreSnapshotTable = (typeof CORE_SNAPSHOT_TABLES)[number];
/** A snapshot table's name. Core tables are the `CoreSnapshotTable` union, held complete by the typed maps below; a registered one is any string. */
export type SnapshotTable = string;

/** Every table a snapshot may hold, in restore order: the core list, then each registered table after its anchor. */
export const SNAPSHOT_TABLES: string[] = [...CORE_SNAPSHOT_TABLES];

/**
 * Columns the system keeps up to date on its own, which a revert neither compares nor writes back. Every agent write
 * enqueues a recalculation that rewrites them within seconds (the planner's occurrence upsert in
 * `platform/database/src/planning/plan-forecast-runtime.ts` and the completion ratios in `completion-ratios.ts`),
 * so comparing them would refuse every undo once the plan had caught up, and restoring them would put stale planner
 * output back until the next run. `updated_at` is skipped on every table that has one for the same reason; a real
 * edit changes `version` or a column the person sees.
 */
const CORE_SYSTEM_COLUMNS: Readonly<Record<CoreSnapshotTable, readonly string[]>> = {
  users: ["updated_at"],
  sources: [],
  captures: ["updated_at"],
  areas: ["updated_at"],
  // Location reports rewrite the device state, and every write moves the horizon, both in the background with no
  // version bump; comparing them would refuse every undo of a catch-up's wake.
  user_preferences: ["updated_at", "device_location_state", "current_horizon_end_at"],
  condition_definitions: ["updated_at"],
  routine_presets: ["updated_at"],
  routine_preset_steps: ["updated_at"],
  routine_preset_step_dependencies: [],
  action_recurrence_windows: ["updated_at"],
  spans: ["updated_at"],
  // The planner redraws the planned night within seconds of any write; the log's own fields are not among these.
  // `planned_start_at`, `planned_wake_at` and `input_version` are the planner's only while the night was not set by
  // hand: see `CONDITIONAL_SYSTEM_COLUMNS`.
  sleep_plans: ["updated_at", "anchor_deviation_minutes", "hard_errors", "explanation", "score_components"],
  // The step placer rewrites the scheduled times and the status of unstarted steps on every replan.
  routine_steps: ["updated_at", "scheduled_start_at", "scheduled_end_at"],
  routine_step_dependencies: [],
  planning_focus_periods: ["updated_at"],
  planning_focus_projects: [],
  daily_plans: ["updated_at"],
  daily_plan_desired_actions: [],
  daily_plan_deferred_actions: [],
  outcomes: ["updated_at"],
  projects: [
    "updated_at",
    "forecast_started_at",
    "baseline_estimate_minutes",
    "actual_completion_ratio",
    "required_completion_ratio"
  ],
  commitment_recurrence_rules: ["updated_at"],
  // `presence` and `share_to_calendar` of a series occurrence follow the series until edited by hand: see
  // `CONDITIONAL_SYSTEM_COLUMNS`.
  commitments: ["updated_at"],
  // Imports refresh `last_seen_at` on every sync; the link itself is what a write sets.
  calendar_event_links: ["updated_at", "last_seen_at"],
  deliverables: ["updated_at"],
  actions: ["updated_at"],
  action_recurrence_rules: ["updated_at"],
  // The link and edge tables hold only their key and what the write set: nothing the planner rewrites.
  action_requirement_pathways: [],
  action_requirements: [],
  action_preferences: [],
  action_dependencies: [],
  deliverable_dependencies: [],
  deliverable_sources: [],
  deliverable_criteria: ["updated_at"],
  deliverable_blockers: ["updated_at"],
  deliverable_criterion_actions: [],
  deliverable_blocker_actions: [],
  action_occurrences: ["updated_at", "window_starts_at", "window_ends_at", "anchor_source", "routine_covered"],
  sessions: ["updated_at"],
  session_segments: ["updated_at"],
  action_cadence_completions: ["updated_at"],
  check_in: ["updated_at"],
  catch_up_runs: ["updated_at"],
  entity_prerequisites: [],
  // An own trip recorded on arrival: the row is what the write set, and nothing rewrites it.
  journey_samples: [],
  // The recorder keeps rewriting what it saw on the open segment (the target, the confirmation, the privacy flag);
  // only the segment's bounds, state and reason say what a re-entry did to it.
  pulse_segments: [
    "updated_at",
    "doing_kind",
    "doing_id",
    "doing_title",
    "expected_kind",
    "expected_id",
    "private",
    "confirmed_at",
    "repainted_at"
  ],
  // The recorder rewrites these every pass; a re-entry images only the memory it moves (`TRACKED_COLUMNS`).
  pulse_state: ["updated_at", "last_evaluated_at", "silence_until", "reentered_at", "reentered_by"],
  pulse_disruptions: ["updated_at"]
};

/**
 * Columns the recorder moves on its own but that an undo must still put back: a revert ignores them when it checks
 * whether the row changed since the write, and restores them like any other column. `last_contact_at` and
 * `last_contact_source` move within seconds of a re-entry, because the next recorder pass re-reads the latest contact
 * from the write log, which includes the re-entry's own row (stamped a few milliseconds after the `at` it used).
 */
export const COMPARE_ONLY_SYSTEM_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pulse_state: ["last_contact_at", "last_contact_source"]
};

/** `CORE_SYSTEM_COLUMNS` plus the registered tables' entries. */
export const SYSTEM_COLUMNS: Record<string, readonly string[]> = { ...CORE_SYSTEM_COLUMNS };

type Image = Record<string, unknown> | null;

/**
 * Columns that are the system's only for some rows, decided from the row's images (before, after, and the undone
 * image on a redo). Each hook returns the columns to skip *in addition to* `SYSTEM_COLUMNS[table]`; a column the
 * hook does not return is compared and restored like any other. A hook sees every image of the row, so a row an
 * agent moved between the two states (planner-owned before, hand-set after) is treated as hand-set.
 */
const CONDITIONAL_SYSTEM_COLUMNS: Partial<
  Record<SnapshotTable, (images: readonly Record<string, unknown>[]) => string[]>
> = {
  // The planner redraws a night within seconds, except one set by hand: the override and a start with another
  // duration write the times themselves with `input_version='override'`, a hand-logged night with 'manual'.
  sleep_plans: (images) => {
    if (images.some((image) => image.input_version === "override" || image.input_version === "manual")) return [];
    // An ordinary night the planner owns is deleted and reinserted by every replan that does not pin it (an answered
    // stay-up offer or placement choice pins it), so what it recomputes moves too, `created_at` among it.
    const replanned = images.every(
      (image) => image.status === "planned" && image.stay_up_answer_minutes == null && image.placement_choice == null
    );
    return [
      "planned_start_at",
      "planned_wake_at",
      "input_version",
      ...(replanned ? ["created_at", "allowed_minutes", "sleep_deficit_minutes", "desired_minutes"] : [])
    ];
  },
  // A series occurrence's presence and family sharing track its rule on every replan while their source is
  // `inherit` (`persistDerivedState` in plan-forecast-runtime.ts); a standalone commitment, or an occurrence whose
  // source is `custom`, holds the value somebody set.
  commitments: (images) => {
    const derived = (source: "presence_source" | "share_source") =>
      images.every((image) => image.recurrence_rule_id != null && image[source] === "inherit");
    return [
      ...(derived("presence_source") ? ["presence"] : []),
      ...(derived("share_source") ? ["share_to_calendar"] : [])
    ];
  }
};

/** The columns a revert neither compares nor writes back for this row: `SYSTEM_COLUMNS` plus any its images make the system's. */
export function systemColumnsFor(table: SnapshotTable, ...images: readonly Image[]): readonly string[] {
  const hook = CONDITIONAL_SYSTEM_COLUMNS[table];
  const present = images.filter((image): image is Record<string, unknown> => image !== null && image !== undefined);
  return hook && present.length > 0 ? [...systemColumnsOf(table), ...hook(present)] : systemColumnsOf(table);
}

/**
 * The link and edge tables that have no `id` column, with their primary-key columns in order. Every other
 * snapshot table is keyed by `id`.
 */
const COMPOSITE_KEYS: Partial<Record<CoreSnapshotTable, readonly string[]>> = {
  user_preferences: ["user_id"],
  pulse_state: ["user_id"],
  entity_prerequisites: ["entity_kind", "entity_id", "requires_kind", "requires_id"],
  condition_definitions: ["user_id", "id"],
  routine_preset_step_dependencies: ["step_id", "depends_on_step_id"],
  routine_step_dependencies: ["step_id", "depends_on_step_id"],
  planning_focus_projects: ["focus_period_id", "project_id"],
  daily_plan_desired_actions: ["daily_plan_id", "action_id"],
  daily_plan_deferred_actions: ["daily_plan_id", "action_id"],
  action_requirements: ["pathway_id", "context_key"],
  action_preferences: ["action_id", "context_key"],
  action_dependencies: ["action_id", "depends_on_action_id"],
  deliverable_dependencies: ["deliverable_id", "depends_on_deliverable_id"],
  deliverable_sources: ["deliverable_id", "source_id"],
  deliverable_criterion_actions: ["criterion_id", "action_id"],
  deliverable_blocker_actions: ["blocker_id", "action_id"]
};

/**
 * The columns that identify a row, per table (`["id"]` unless the table is composite-keyed). A row's `id` in a
 * snapshot is the plain id for an `id` table, so snapshots stored before composite keys existed still read, and
 * for a composite table the JSON array of its key values in this column order, as text
 * (`'["<pathway uuid>","home"]'`).
 */
export const SNAPSHOT_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  CORE_SNAPSHOT_TABLES.map((table) => [table, COMPOSITE_KEYS[table] ?? ["id"]])
);

/** The key columns of a snapshot table; throws for a table that is not one. */
export function snapshotKeyColumns(table: string): readonly string[] {
  const columns = SNAPSHOT_KEYS[table];
  if (!columns) throw new Error(`${table} cannot be snapshotted.`);
  return columns;
}

/** The columns a revert skips on a snapshot table, before any conditional ones. */
function systemColumnsOf(table: string): readonly string[] {
  const columns = SYSTEM_COLUMNS[table];
  if (!columns) throw new Error(`${table} cannot be snapshotted.`);
  return columns;
}

/** A table a feature the export leaves out adds to the snapshot list. */
export interface SnapshotTableExtension {
  table: string;
  /** The table it follows in restore order: its parent, so a restore inserts the parent first. Must already be in the list. */
  after: string;
  /** Columns a revert neither compares nor writes back (`updated_at` and any the system rewrites). */
  systemColumns: readonly string[];
  /** Primary-key columns for a link table with no `id`; `["id"]` when absent. */
  key?: readonly string[];
}

/** Adds a table to the snapshot list. Idempotent; an unknown anchor throws, so a misspelt parent fails at load. */
export function registerSnapshotTable(extension: SnapshotTableExtension): void {
  if (SNAPSHOT_TABLES.includes(extension.table)) return;
  const anchor = SNAPSHOT_TABLES.indexOf(extension.after);
  if (anchor < 0) throw new Error(`${extension.table} must follow a snapshot table; ${extension.after} is not one.`);
  SNAPSHOT_TABLES.splice(anchor + 1, 0, extension.table);
  SYSTEM_COLUMNS[extension.table] = extension.systemColumns;
  SNAPSHOT_KEYS[extension.table] = extension.key ?? ["id"];
}

/** What names a row to `before` / `inserted`: its id for an `id` table, the key values in order for a composite one. */
export type SnapshotKey = string | readonly string[];

/** The stored `id` of a row. */
export function encodeKey(table: SnapshotTable, key: SnapshotKey): string {
  const columns = snapshotKeyColumns(table);
  if (columns.length === 1) {
    if (typeof key !== "string") throw new Error(`${table} is keyed by one column; pass its value.`);
    return key;
  }
  if (typeof key === "string" || key.length !== columns.length)
    throw new Error(`${table} is keyed by (${columns.join(", ")}); pass those ${columns.length} values.`);
  return JSON.stringify([...key]);
}

/** The key values a stored `id` stands for, in `SNAPSHOT_KEYS` order. */
export function decodeKey(table: SnapshotTable, id: string): string[] {
  if (snapshotKeyColumns(table).length === 1) return [id];
  const values: unknown = JSON.parse(id);
  if (
    !Array.isArray(values) ||
    values.length !== snapshotKeyColumns(table).length ||
    !values.every((value) => typeof value === "string")
  )
    throw new Error(`The stored key ${id} does not fit ${table}.`);
  return values as string[];
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * A WHERE condition naming these rows (by stored `id`) on table alias `alias`, with its parameters numbered from
 * `first`. The column names come from `SNAPSHOT_KEYS`, this module's own constants. Values are compared as text,
 * so a uuid column matches its string.
 */
export function keyCondition(
  table: SnapshotTable,
  alias: string,
  ids: readonly string[],
  first = 1
): { where: string; params: string[] } {
  const columns = snapshotKeyColumns(table).map((name) => `${alias}.${quote(name)}::text`);
  const tuples = ids.map((id) => decodeKey(table, id));
  let next = first;
  const rows = tuples.map((values) => values.map(() => `$${next++}`));
  const where =
    columns.length === 1
      ? `${columns[0]} IN (${rows.map((row) => row[0]).join(", ")})`
      : `(${columns.join(", ")}) IN (${rows.map((row) => `(${row.join(", ")})`).join(", ")})`;
  return { where, params: tuples.flat() };
}

/**
 * For a wide row that many unrelated writes touch, the only columns a kind of write keeps, compares and writes back.
 * The settings row holds every preference, the device's location and the planning horizon, which settings saves and
 * location observations rewrite all day; a wake changes just the last wake and the place slept in, so its image of
 * the row is those, with the key, and the version and `updated_at` the revert bumps. An unrelated settings save made
 * since then neither refuses the wake's undo nor is put back by it. Everything else is imaged whole.
 */
export const TRACKED_COLUMNS: Partial<Record<SnapshotKind, Partial<Record<SnapshotTable, readonly string[]>>>> = {
  wake: { user_preferences: ["user_id", "last_woke_at", "current_situation", "version", "updated_at"] },
  // A re-entry sets the situation facts (energy, contexts, place) and moves the pulse's memory; nothing else on
  // those rows is its to put back.
  reenter: {
    user_preferences: [
      "user_id",
      "asserted_conditions",
      "current_energy",
      "current_situation",
      "version",
      "updated_at"
    ],
    pulse_state: [
      "user_id",
      "entered_lapsed_at",
      "last_confirmed_at",
      "confirmed_by",
      "last_contact_at",
      "last_contact_source",
      "unknown_since",
      "unknown_minutes",
      "unanswered_prompts"
    ]
  }
};

/**
 * The SQL expression for a row's image on `alias`: the whole row as jsonb, or the columns `TRACKED_COLUMNS` names for
 * this kind of write. The names are this module's own constants, so they are written into the query.
 */
export function imageExpression(table: SnapshotTable, alias: string, kind?: SnapshotKind): string {
  const tracked = kind === undefined ? undefined : TRACKED_COLUMNS[kind]?.[table];
  if (!tracked) return `to_jsonb(${alias})`;
  const names = tracked.map((name) => `'${name}'`).join(", ");
  return `(SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(to_jsonb(${alias})) e WHERE e.key IN (${names}))`;
}

/**
 * The current images of rows by stored `id`, optionally locked `FOR UPDATE`, as `kind` images them (`imageExpression`).
 * A row that does not exist is absent from the map.
 */
export async function readImages(
  tx: Sql,
  table: SnapshotTable,
  ids: readonly string[],
  lock: boolean,
  kind?: SnapshotKind
): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();
  const { where, params } = keyCondition(table, "t", ids);
  // The key columns are read as text so a bigint id keeps every digit; the image carries the rest.
  const keys = snapshotKeyColumns(table)
    .map((name, index) => `t.${quote(name)}::text AS k${index}`)
    .join(", ");
  const found = await tx.unsafe<Record<string, unknown>[]>(
    `SELECT ${keys}, ${imageExpression(table, "t", kind)} AS image FROM ${quote(table)} t WHERE ${where}${lock ? " FOR UPDATE" : ""}`,
    params
  );
  return new Map(
    found.map((row) => {
      const values = snapshotKeyColumns(table).map((_, index) => String(row[`k${index}`]));
      return [encodeKey(table, values.length === 1 ? values[0]! : values), row.image as Record<string, unknown>];
    })
  );
}

/** One row a write touched: `before` is null for a row the write created, `after` null for one it deleted. */
export interface SnapshotRow {
  table: SnapshotTable;
  /** The row's key as `encodeKey` gives it: the plain id, or for a composite table the JSON array of its key values. */
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** What kind of write a snapshot holds; shown in the change log and refused by the revert when unknown. */
export type SnapshotKind =
  | "session"
  | "check_in"
  | "catch_up"
  | "confirm"
  | "save"
  | "activity"
  | "recurrence"
  | "cadence"
  | "wake"
  | "reenter"
  | "disruption";

/** The most snapshots kept per user; older ones are dropped on insert, so their writes can no longer be undone. */
export const SNAPSHOT_LIMIT = 500;

function assertTable(table: string): asserts table is SnapshotTable {
  if (!(SNAPSHOT_TABLES as readonly string[]).includes(table)) throw new Error(`${table} cannot be snapshotted.`);
}

export class WriteSnapshot {
  private readonly rows = new Map<string, SnapshotRow>();
  private readonly watches: { table: SnapshotTable; where: string; params: unknown[] }[] = [];

  private constructor(
    private readonly tx: Sql,
    private readonly userId: string,
    private readonly commandId: string,
    private readonly agent: string | null,
    private readonly kind: SnapshotKind
  ) {}

  /**
   * A snapshot for this write when an agent is making it, otherwise null (call its methods with `?.`) and no lock
   * is taken. Open it first in the write's transaction, before the command's first row lock: the snapshot's watches
   * lock rows `FOR UPDATE` (occurrences, steps, ...) that the worker's plan publish also locks, and the publish
   * takes the per-user publication lock first. A command must therefore take that lock before any row lock
   * (`holdPlanForecastPublication`), or the two close a cycle and Postgres fails one with a deadlock.
   */
  static async open(tx: Sql, userId: string, commandId: string, kind: SnapshotKind): Promise<WriteSnapshot | null> {
    const agent = requestAgent();
    if (agent === null) return null;
    await holdPlanForecastPublication(tx, userId);
    return new WriteSnapshot(tx, userId, commandId, agent, kind);
  }

  /**
   * A snapshot for a write that is undoable whoever makes it: the agent's name when one is, else the person's (a
   * `null` actor, which the owner may undo). Re-entry is such a write: the owner's sheet and an agent's tool call
   * both end the same lapse, so both must be able to put it back.
   */
  static forWrite(tx: Sql, userId: string, commandId: string, kind: SnapshotKind): WriteSnapshot {
    return new WriteSnapshot(tx, userId, commandId, requestAgent(), kind);
  }

  /**
   * Records the rows' before-images. Call it before the write changes them, inside the write's transaction; the
   * rows are locked `FOR UPDATE`. A row already recorded keeps its first image; a key with no row is recorded as
   * absent (the write creates it). A key is the id for an `id` table and the key values in `SNAPSHOT_KEYS` order
   * (`[actionId, "home"]`) for a composite one.
   */
  async before(table: SnapshotTable, keys: readonly SnapshotKey[]): Promise<void> {
    assertTable(table);
    const fresh = [...new Set(keys.map((key) => encodeKey(table, key)))].filter(
      (id) => !this.rows.has(`${table}:${id}`)
    );
    if (fresh.length === 0) return;
    const images = await readImages(this.tx, table, fresh, true, this.kind);
    for (const id of fresh) this.rows.set(`${table}:${id}`, { table, id, before: images.get(id) ?? null, after: null });
  }

  /**
   * Records every row of `table` matching `where` (a condition on alias `t`, parameters `$1...` from `params`; written
   * by the caller's own code, never from request text) as it is now, locked `FOR UPDATE`, and remembers the condition:
   * `save` runs it again and records any row it finds then that was not here before as created by the write. For a
   * write that deletes and re-inserts children under fresh ids (an action's requirement routes), or whose rows the
   * code cannot name before it runs.
   */
  async watch(table: SnapshotTable, where: string, params: readonly unknown[] = []): Promise<void> {
    assertTable(table);
    const list = [...params];
    this.watches.push({ table, where, params: list });
    for (const [id, image] of await this.matching(table, where, list, true))
      if (!this.rows.has(`${table}:${id}`)) this.rows.set(`${table}:${id}`, { table, id, before: image, after: null });
  }

  private async matching(
    table: SnapshotTable,
    where: string,
    params: unknown[],
    lock: boolean
  ): Promise<Map<string, Record<string, unknown>>> {
    const keys = snapshotKeyColumns(table)
      .map((name, index) => `t.${quote(name)}::text AS k${index}`)
      .join(", ");
    const found = await this.tx.unsafe<Record<string, unknown>[]>(
      `SELECT ${keys}, ${imageExpression(table, "t", this.kind)} AS image FROM ${quote(table)} t WHERE ${where}${lock ? " FOR UPDATE" : ""}`,
      params as never[]
    );
    return new Map(
      found.map((row) => {
        const values = snapshotKeyColumns(table).map((_, index) => String(row[`k${index}`]));
        return [encodeKey(table, values.length === 1 ? values[0]! : values), row.image as Record<string, unknown>];
      })
    );
  }

  /** Records rows the write created (they had no before-image). Keys as for `before`. */
  inserted(table: SnapshotTable, keys: readonly SnapshotKey[]): void {
    assertTable(table);
    for (const key of keys) {
      const id = encodeKey(table, key);
      if (!this.rows.has(`${table}:${id}`)) this.rows.set(`${table}:${id}`, { table, id, before: null, after: null });
    }
  }

  /**
   * Reads every recorded row as the write left it and stores the snapshot. Call it once, after the write's last
   * change and inside the same transaction. A row neither changed nor created is left out; a write that changed
   * nothing stores nothing.
   */
  async save(): Promise<void> {
    // Rows a watched condition matches now that it did not before were created by the write.
    for (const watch of this.watches)
      for (const id of (await this.matching(watch.table, watch.where, watch.params, false)).keys())
        if (!this.rows.has(`${watch.table}:${id}`))
          this.rows.set(`${watch.table}:${id}`, { table: watch.table, id, before: null, after: null });
    const byTable = new Map<SnapshotTable, SnapshotRow[]>();
    for (const row of this.rows.values()) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row]);
    for (const [table, rows] of byTable) {
      const images = await readImages(
        this.tx,
        table,
        rows.map((row) => row.id),
        false,
        this.kind
      );
      for (const row of rows) row.after = images.get(row.id) ?? null;
    }
    const changed = [...this.rows.values()].filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));
    if (changed.length === 0) return;
    // The write's header was claimed by its command; the images ride on it. A write that already kept images keeps them.
    await this.tx`
      UPDATE writes SET kind=${this.kind}, images=${this.tx.json(changed as never)}, state='applied', updated_at=now()
      WHERE id=${this.commandId} AND user_id=${this.userId} AND images IS NULL`;
    // Past the newest SNAPSHOT_LIMIT the header stays and only the images go (the write can no longer be undone).
    await this.tx`
      UPDATE writes SET images=NULL, state=NULL WHERE user_id=${this.userId} AND id IN (
        SELECT id FROM writes WHERE user_id=${this.userId} AND images IS NOT NULL
        ORDER BY created_at DESC, id DESC OFFSET ${SNAPSHOT_LIMIT})`;
  }
}
