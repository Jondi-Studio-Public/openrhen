import { prerequisiteNodes } from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import { booleanOption, requirePositional, type CommandSpec } from "../command.js";
import { restoreCallOf, restoreCallText } from "../closed-rows.js";
import { entityItems, findEntity, type AnyRecord, type EntityDefinition } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, pickFields, renderRecord, renderTable, toJson } from "../output.js";
import { keepProvenance } from "../outside-text.js";
import { asRecords, lookupById, resolveByIdOrPrefix } from "../resolve.js";

/** Relation lists longer than this are cut off by default; `--all` lifts the cap. */
const RELATION_CAP = 20;

interface ListRelation {
  kind: "list";
  label: string;
  columns: string[];
  rows: AnyRecord[];
  /** Rows that matched, before any capping. */
  total: number;
  /** A full `list` command that shows every matching row, when one entity/filter combination covers it. */
  hint?: string;
}
interface RecordRelation {
  kind: "record";
  label: string;
  record: AnyRecord | undefined;
}
type Relation = ListRelation | RecordRelation;

// Small, reused column sets so relations read as a summary, not a second copy of the full record.
const PROJECT_LIST_COLS = ["id", "title", "status"];
const PROJECT_REF_COLS = ["id", "title"];
const OUTCOME_REF_COLS = ["id", "title"];
const AREA_REF_COLS = ["id", "name"];
const ACTION_LIST_COLS = ["id", "title", "status"];
const PLACE_COLS = ["id", "name", "address", "travelMinutes"];
const PLACE_LIST_COLS = ["id", "name"];
const COMMITMENT_LIST_COLS = ["id", "title", "startsAt", "status"];

export const showCommand: CommandSpec = {
  name: "show",
  summary: "Show one entity in full, with what it relates to",
  description:
    "Prints every field of one entity and the records around it: a project's actions and deliverables, an " +
    "action's project and dependencies, a commitment's place, series, and routine steps, and so on. " +
    "The id may be shortened to a unique prefix. Relation lists longer than 20 rows are cut off with a note " +
    "on how to see the rest (--all, or the `list` command with the matching filter); --brief skips relations " +
    "entirely and prints just the record. A closed record carries restore, the call that reopens it.",
  positionals: [
    { name: "entity", required: true, description: "The entity kind, singular or plural" },
    { name: "id", required: true, description: "The entity id, or a unique prefix of it" }
  ],
  options: {
    brief: { type: "boolean", description: "Print only the record itself, without related entities" },
    all: { type: "boolean", description: "Show every row of every relation, lifting the default 20-row cap" }
  },
  mutates: false,
  examples: [
    "show project 3f2a",
    "show action 8c1d9e2b-… --json",
    "show commitment 5b7e",
    "show commitment 5b7e --brief"
  ],
  async run(context, args) {
    const entityArg = requirePositional(showCommand, args, 0);
    const idArg = requirePositional(showCommand, args, 1);
    const entity = findEntity(entityArg);
    if (!entity) throw new CliError(`Unknown entity "${entityArg}".`, EXIT.usage);

    const state = await context.client.getState();
    const item = resolveByIdOrPrefix(entityItems(state, entity), idArg, entity.singular);
    const brief = booleanOption(args.values, "brief");
    const all = booleanOption(args.values, "all");
    const relations = brief ? {} : buildRelations(state, entity, item, all, context.now());
    const timeZone = state.settings.timezone;

    if (context.mode === "json" || context.mode === "jsonl") {
      const restore = restoreCallOf(entity.name, item);
      const doc: Record<string, unknown> = { entity: entity.singular, item, ...(restore ? { restore } : {}) };
      if (!brief) {
        const relationValues: Record<string, unknown> = {};
        const truncated: Record<string, unknown> = {};
        for (const [key, relation] of Object.entries(relations)) {
          if (relation.kind === "list") {
            relationValues[key] = relation.rows;
            if (relation.total > relation.rows.length)
              truncated[key] = { total: relation.total, shown: relation.rows.length, hint: relation.hint ?? null };
          } else relationValues[key] = relation.record ?? null;
        }
        doc.relations = relationValues;
        if (Object.keys(truncated).length > 0) doc.truncated = truncated;
      }
      context.stdout(toJson(localiseInstants(doc, timeZone), true));
      return;
    }

    const parts: string[] = [renderRecord(item, { timeZone })];
    const restore = restoreCallOf(entity.name, item);
    if (restore) parts.push(`Closed. To reopen: ${restoreCallText(restore, context.mcp === true)}`);
    for (const relation of Object.values(relations)) {
      if (relation.kind === "list") {
        if (relation.total === 0) continue;
        const table = `${relation.label} (${relation.total})\n${renderTable(relation.rows, relation.columns, { timeZone })}`;
        const remaining = relation.total - relation.rows.length;
        const note =
          remaining <= 0
            ? ""
            : relation.hint
              ? `\n+${remaining} more, use \`rhen ${relation.hint}\``
              : `\n+${remaining} more, use --all to show every row`;
        parts.push(`${table}${note}`);
      } else if (relation.record) parts.push(`${relation.label}\n${renderRecord(relation.record, { timeZone })}`);
    }
    context.stdout(parts.join("\n\n"));
  }
};

function buildRelations(
  state: PortalState,
  entity: EntityDefinition,
  item: AnyRecord,
  all = false,
  now: Date = new Date()
): Record<string, Relation> {
  const relations: Record<string, Relation> = {};
  const list = (key: string, label: string, columns: string[], rows: AnyRecord[], hint?: string) => {
    const capped = all || rows.length <= RELATION_CAP ? rows : rows.slice(0, RELATION_CAP);
    relations[key] = {
      kind: "list",
      label,
      columns,
      rows: capped.map((row) => keepProvenance(row, pickFields(row, columns))),
      total: rows.length,
      ...(hint ? { hint } : {})
    };
  };
  const record = (key: string, label: string, value: AnyRecord | undefined, columns?: string[]) => {
    relations[key] = {
      kind: "record",
      label,
      record: value && columns ? keepProvenance(value, pickFields(value, columns)) : value
    };
  };

  const projects = asRecords(state.projects);
  const outcomes = asRecords(state.outcomes);
  const areas = asRecords(state.areas);
  const actions = asRecords(state.actions);
  const deliverables = asRecords(state.deliverables);
  const commitments = asRecords(state.commitments);
  const rules = asRecords(state.commitmentRecurrenceRules);
  const routineSteps = asRecords(state.routineSteps);
  const routinePresets = asRecords(state.routinePresets);
  const occurrences = asRecords(state.occurrences);
  const sessions = asRecords(state.completedToday);
  const conditions = asRecords(state.conditionDefinitions);

  // Edges beyond same-kind dependencyIds: any edge from or to a project, and mixed kinds.
  const prerequisiteRelations = (kind: "project" | "deliverable" | "action") => {
    const nodes = prerequisiteNodes({ projects, deliverables, actions } as unknown as Parameters<
      typeof prerequisiteNodes
    >[0]);
    const byKey = new Map(nodes.map((node) => [`${node.kind}:${node.id}`, node]));
    const self = byKey.get(`${kind}:${String(item.id)}`);
    const status = (node: { kind: string; id: string }) => {
      const source = node.kind === "project" ? projects : node.kind === "deliverable" ? deliverables : actions;
      return source.find((record) => record.id === node.id)?.status;
    };
    const row = (node: { kind: string; id: string; title?: string | undefined }) => ({
      kind: node.kind,
      id: node.id,
      title: node.title ?? node.id,
      status: status(node)
    });
    list(
      "prerequisites",
      kind === "project" ? "Prerequisites" : "Prerequisites (other kinds)",
      ["kind", "id", "title", "status"],
      (self?.prerequisites ?? []).map((ref) => row({ ...ref, title: byKey.get(`${ref.kind}:${ref.id}`)?.title }))
    );
    list(
      "requiredBy",
      kind === "project" ? "Required by" : "Required by (other kinds)",
      ["kind", "id", "title", "status"],
      nodes
        .filter((node) => node.prerequisites.some((ref) => ref.kind === kind && ref.id === item.id))
        .map((node) => row(node))
    );
  };

  switch (entity.name) {
    case "areas": {
      const areaOutcomes = outcomes.filter((outcome) => outcome.areaId === item.id);
      list("outcomes", "Outcomes", ["id", "title", "status"], areaOutcomes, `list outcomes --area ${item.id}`);
      const outcomeIds = new Set(areaOutcomes.map((outcome) => outcome.id));
      list(
        "projects",
        "Projects",
        PROJECT_LIST_COLS,
        projects.filter((project) => outcomeIds.has(project.outcomeId)),
        `list projects --area ${item.id}`
      );
      break;
    }
    case "outcomes": {
      record("area", "Area", lookupById(areas, str(item, "areaId")), AREA_REF_COLS);
      list(
        "projects",
        "Projects",
        PROJECT_LIST_COLS,
        projects.filter((project) => project.outcomeId === item.id),
        `list projects --outcome ${item.id}`
      );
      break;
    }
    case "projects": {
      record("outcome", "Outcome", lookupById(outcomes, str(item, "outcomeId")), OUTCOME_REF_COLS);
      record("area", "Area", lookupById(areas, str(item, "area")), AREA_REF_COLS);
      list(
        "actions",
        "Actions",
        ["id", "title", "status", "remainingMinutes", "deadlineAt"],
        actions.filter((action) => action.projectId === item.id),
        `list actions --project ${item.id}`
      );
      list(
        "deliverables",
        "Deliverables",
        ["id", "title", "status", "externalDeadlineAt"],
        deliverables.filter((deliverable) => deliverable.projectId === item.id),
        `list deliverables --project ${item.id}`
      );
      prerequisiteRelations("project");
      break;
    }
    case "actions": {
      record("project", "Project", lookupById(projects, str(item, "projectId")), PROJECT_REF_COLS);
      const dependencyIds = new Set(strArray(item, "dependencyIds"));
      list(
        "dependencies",
        "Dependencies",
        ACTION_LIST_COLS,
        actions.filter((action) => typeof action.id === "string" && dependencyIds.has(action.id))
      );
      list(
        "dependants",
        "Dependants",
        ACTION_LIST_COLS,
        actions.filter((action) => strArray(action, "dependencyIds").includes(item.id as string))
      );
      prerequisiteRelations("action");
      list(
        "occurrences",
        "Occurrences",
        ["id", "localDate", "windowStartsAt", "status"],
        occurrences.filter((occurrence) => occurrence.actionId === item.id),
        `list occurrences --action ${item.id}`
      );
      list(
        "sessions",
        "Sessions",
        ["id", "result", "startedAt", "endedAt", "activeMinutes"],
        sessions.filter((session) => session.actionId === item.id),
        `list sessions --action ${item.id}`
      );
      break;
    }
    case "deliverables": {
      record("project", "Project", lookupById(projects, str(item, "projectId")), PROJECT_REF_COLS);
      const dependencyIds = new Set(strArray(item, "dependencyIds"));
      list(
        "dependencies",
        "Dependencies",
        ["id", "title", "status"],
        deliverables.filter((deliverable) => typeof deliverable.id === "string" && dependencyIds.has(deliverable.id))
      );
      list(
        "dependants",
        "Dependants",
        ["id", "title", "status"],
        deliverables.filter((deliverable) => strArray(deliverable, "dependencyIds").includes(item.id as string))
      );
      prerequisiteRelations("deliverable");
      break;
    }
    case "commitments": {
      record("project", "Project", lookupById(projects, str(item, "projectId")), PROJECT_REF_COLS);
      record("place", "Place", lookupById(conditions, str(item, "locationId")), PLACE_COLS);
      record("rule", "Rule", lookupById(rules, str(item, "recurrenceRuleId")));
      list(
        "routineSteps",
        "Routine steps",
        ["id", "title", "phase", "sequence", "status", "scheduledStartAt"],
        routineSteps.filter((step) => step.commitmentId === item.id),
        `list routine-steps --commitment ${item.id}`
      );
      record("preset", "Preset", lookupById(routinePresets, str(item, "routinePresetId")));
      break;
    }
    case "commitment-rules": {
      list(
        "commitments",
        "Commitments",
        ["id", "localDate", "startsAt", "status"],
        commitments.filter((commitment) => commitment.recurrenceRuleId === item.id)
      );
      record("place", "Place", lookupById(conditions, str(item, "locationId")), PLACE_COLS);
      break;
    }
    case "routine-steps": {
      record("commitment", "Commitment", lookupById(commitments, str(item, "commitmentId")), [
        "id",
        "title",
        "startsAt"
      ]);
      break;
    }
    case "routine-presets": {
      list(
        "places",
        "Places",
        PLACE_LIST_COLS,
        conditions.filter((condition) => condition.defaultRoutinePresetId === item.id)
      );
      // What the state shape can actually tell us: a commitment's own routineSource/routinePresetId, and
      // a place's defaultRoutinePresetId. That resolves both a direct pin (routineSource='preset') and a
      // place-inherited one (routineSource absent/'inherit') to this preset. It cannot resolve a 'custom'
      // (detached) commitment that inherited this preset before being detached — 'inherit' never stored a
      // routinePresetId to begin with, so that lineage is gone from the state the moment it detaches. A
      // 'custom' commitment shows up here only if it was pinned directly (routineSource was 'preset')
      // before detaching, since routinePresetId survives that.
      const usedBy = commitments.filter(
        (commitment) =>
          commitment.status !== "cancelled" &&
          typeof commitment.startsAt === "string" &&
          new Date(commitment.startsAt).getTime() > now.getTime() &&
          resolvedPresetIdFor(commitment, conditions) === item.id
      );
      list(
        "usedBy",
        "Used by (direct preset or place-inherited only; see note)",
        ["id", "title", "startsAt", "sync"],
        usedBy.map((commitment) => ({ ...commitment, sync: routineSyncStatus(commitment, routineSteps) }))
      );
      // A step's own `cadenceActionId` is otherwise just a bare id in the record dump above — resolved
      // here to the linked action's title, the same way `usedBy` above resolves a commitment reference
      // rather than leaving it as an id. Only cadence-linked steps are listed; the rest of the preset's
      // steps are already visible in the full record.
      const cadenceSteps = (Array.isArray(item.steps) ? (item.steps as AnyRecord[]) : [])
        .filter((step) => typeof step.cadenceActionId === "string")
        .map((step) => ({
          id: step.id,
          title: step.title,
          sequence: step.sequence,
          cadenceAction: lookupById(actions, str(step, "cadenceActionId"))?.title ?? step.cadenceActionId
        }));
      list(
        "cadenceLinks",
        "Steps linked to a cadence action",
        ["id", "title", "sequence", "cadenceAction"],
        cadenceSteps
      );
      break;
    }
    case "occurrences": {
      record("action", "Action", lookupById(actions, str(item, "actionId")), ["id", "title", "status"]);
      break;
    }
    case "sleep-plans": {
      const wakeConstraint = item.wakeConstraint;
      const commitmentId =
        wakeConstraint && typeof wakeConstraint === "object"
          ? str(wakeConstraint as AnyRecord, "commitmentId")
          : undefined;
      record(
        "wakeConstraint",
        "Wake constraint commitment",
        lookupById(commitments, commitmentId),
        COMMITMENT_LIST_COLS
      );
      break;
    }
    case "planning-focus": {
      const projectIds = new Set(strArray(item, "projectIds"));
      list(
        "projects",
        "Projects",
        PROJECT_LIST_COLS,
        projects.filter((project) => typeof project.id === "string" && projectIds.has(project.id))
      );
      break;
    }
    case "captures":
      break;
    case "conditions": {
      list(
        "commitments",
        "Commitments",
        ["id", "title", "startsAt", "status"],
        commitments.filter((commitment) => commitment.locationId === item.id && commitment.status !== "cancelled")
      );
      // Live kind only: which series or one-off this condition tracks, named rather than left as
      // a bare id — exactly one of the two is ever set (contracts refinement).
      if (item.kind === "live") {
        record("rule", "Recurring commitment", lookupById(rules, str(item, "recurrenceRuleId")), ["id", "title"]);
        record("commitment", "Commitment", lookupById(commitments, str(item, "commitmentId")), COMMITMENT_LIST_COLS);
      }
      break;
    }
    case "sessions": {
      record("action", "Action", lookupById(actions, str(item, "actionId")), ["id", "title", "status"]);
      break;
    }
    default:
      break;
  }

  return relations;
}

function str(item: AnyRecord | undefined, field: string): string | undefined {
  if (!item) return undefined;
  const value = item[field];
  return typeof value === "string" ? value : undefined;
}

function strArray(item: AnyRecord, field: string): string[] {
  const value = item[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Which preset a commitment's routine currently resolves to, from the state shape alone: 'preset' and
 * (surviving detach) 'custom' read routinePresetId directly; 'inherit' (or an absent routineSource) reads
 * the commitment's place's own defaultRoutinePresetId; 'none' resolves to nothing.
 */
function resolvedPresetIdFor(commitment: AnyRecord, conditions: readonly AnyRecord[]): string | undefined {
  const source = typeof commitment.routineSource === "string" ? commitment.routineSource : "inherit";
  if (source === "none") return undefined;
  if (source === "preset" || source === "custom")
    return typeof commitment.routinePresetId === "string" ? commitment.routinePresetId : undefined;
  const place = conditions.find((condition) => condition.id === commitment.locationId && condition.kind === "location");
  return place && typeof place.defaultRoutinePresetId === "string" ? place.defaultRoutinePresetId : undefined;
}

/**
 * 'custom' once detached. Otherwise 'inherits': the sync is per step, so a done/skipped/in-progress
 * step keeps its own content while the commitment's remaining pending steps still pick up preset edits
 * — the commitment as a whole is never frozen, so this names how many steps are sitting out the sync
 * rather than reporting the commitment as locked.
 */
function routineSyncStatus(commitment: AnyRecord, routineSteps: readonly AnyRecord[]): string {
  if (commitment.routineSource === "custom") return "custom";
  const notPending = routineSteps.filter(
    (step) => step.commitmentId === commitment.id && step.status !== "pending"
  ).length;
  return notPending > 0 ? `inherits (${notPending} step${notPending === 1 ? "" : "s"} done)` : "inherits";
}
