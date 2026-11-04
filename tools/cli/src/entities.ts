import {
  actionStatusSchema,
  captureStatusSchema,
  commitmentRecurrenceRuleStatusSchema,
  commitmentStatusSchema,
  conditionStatusSchema,
  deliverableStatusSchema,
  lifecycleStatusSchema,
  occurrenceStatusSchema,
  routinePresetStatusSchema,
  routineStepStatusSchema,
  sleepPlanStatusSchema
} from "@openrhen/contracts";
import type { PortalState } from "./client.js";

export type AnyRecord = Record<string, unknown>;

/** The shared `list` filters. Each entity names the subset that means something for it. */
export type FilterName =
  | "project"
  | "area"
  | "outcome"
  | "action"
  | "commitment"
  | "preset"
  | "status"
  | "scheduling-mode"
  | "search"
  | "since"
  | "from"
  | "to";

export interface EntityDefinition {
  /** Kebab-case plural used on the command line, e.g. `capacity-windows`. */
  name: string;
  singular: string;
  /** The `PortalState` array this entity lives in. */
  key: keyof PortalState;
  aliases: string[];
  /** Default table columns; dotted paths such as `steps.length` are allowed. */
  columns: string[];
  /** Fields `--search` looks in. */
  searchFields: string[];
  filters: FilterName[];
  /**
   * The statuses the entity's records can carry, which `--status` is checked against. Present for every
   * entity that takes `--status`; the portal state schema (`platform/contracts/src/portal/state-schema.ts`)
   * owns the values, and a test holds this list to the statuses the fixture state actually uses.
   */
  statuses?: readonly string[];
  /** The instant `--from` and `--to` compare against, when the entity has one. */
  timeField?: string;
  /** The instant `--since` compares against; falls back to `timeField`. */
  createdField?: string;
}

const define = (definition: EntityDefinition): EntityDefinition => definition;

export const entityCatalogue: EntityDefinition[] = [
  define({
    name: "areas",
    singular: "area",
    key: "areas",
    aliases: [],
    columns: ["id", "name", "status", "sortOrder"],
    searchFields: ["name", "description"],
    statuses: lifecycleStatusSchema.options,
    filters: ["status", "search"]
  }),
  define({
    name: "outcomes",
    singular: "outcome",
    key: "outcomes",
    aliases: [],
    columns: ["id", "title", "areaId", "status", "value", "deadlineAt"],
    searchFields: ["title", "definitionOfDone"],
    statuses: lifecycleStatusSchema.options,
    filters: ["area", "status", "search"]
  }),
  define({
    name: "projects",
    singular: "project",
    key: "projects",
    aliases: [],
    columns: ["id", "title", "area", "outcomeId", "status", "value", "consequence", "externalDeadlineAt"],
    searchFields: ["title"],
    statuses: lifecycleStatusSchema.options,
    filters: ["area", "outcome", "status", "search", "since"],
    createdField: "createdAt"
  }),
  define({
    name: "actions",
    singular: "action",
    key: "actions",
    aliases: ["tasks"],
    columns: [
      "id",
      "title",
      "projectId",
      "status",
      "remainingMinutes",
      "energy",
      "importance",
      "deadlineAt",
      "schedulingMode",
      // How many of the estimate and judgement fields are still a default or a guess; `show` and --json name them.
      "assumedFields.length"
    ],
    searchFields: ["title", "notes"],
    statuses: actionStatusSchema.options,
    filters: ["project", "area", "status", "scheduling-mode", "search", "since"],
    createdField: "createdAt"
  }),
  define({
    name: "deliverables",
    singular: "deliverable",
    key: "deliverables",
    aliases: [],
    // `steps` is the wire field name for a deliverable's actions (stored in the same `actions`
    // table as everything else, unchanged on the wire) — the dotted path here follows that field, not
    // a display label.
    columns: ["id", "title", "projectId", "status", "externalDeadlineAt", "importance", "steps.length"],
    searchFields: ["title", "details"],
    statuses: deliverableStatusSchema.options,
    filters: ["project", "area", "status", "search", "since"],
    createdField: "createdAt"
  }),
  define({
    name: "commitments",
    singular: "commitment",
    key: "commitments",
    aliases: [],
    columns: ["id", "title", "startsAt", "endsAt", "status", "location", "presence", "recurrenceRuleId"],
    searchFields: ["title", "location"],
    statuses: commitmentStatusSchema.options,
    filters: ["project", "preset", "status", "search", "since", "from", "to"],
    timeField: "startsAt",
    createdField: "createdAt"
  }),
  define({
    name: "commitment-rules",
    singular: "commitment-rule",
    key: "commitmentRecurrenceRules",
    aliases: ["recurrence-rules"],
    columns: ["id", "title", "startDate", "endDate", "repeat", "localStartTime", "localEndTime", "status"],
    searchFields: ["title", "location"],
    statuses: commitmentRecurrenceRuleStatusSchema.options,
    filters: ["project", "status", "search"]
  }),
  define({
    name: "routine-steps",
    singular: "routine-step",
    key: "routineSteps",
    aliases: [],
    // one table for either anchor now — `commitmentId` is set for a commitment's own
    // preparation step; `anchorType`/`anchorId`/`purpose` distinguish a bedtime/wake step, which has
    // no `commitmentId` at all.
    columns: [
      "id",
      "anchorType",
      "commitmentId",
      "purpose",
      "title",
      "phase",
      "sequence",
      "durationMinutes",
      "status",
      "scheduledStartAt"
    ],
    searchFields: ["title"],
    statuses: routineStepStatusSchema.options,
    filters: ["commitment", "status", "search", "from", "to"],
    timeField: "scheduledStartAt"
  }),
  define({
    name: "routine-presets",
    singular: "routine-preset",
    key: "routinePresets",
    aliases: ["presets"],
    columns: ["id", "name", "activityName", "status", "steps.length"],
    searchFields: ["name", "activityName"],
    statuses: routinePresetStatusSchema.options,
    filters: ["status", "search"]
  }),
  define({
    name: "occurrences",
    singular: "occurrence",
    key: "occurrences",
    aliases: [],
    columns: ["id", "actionId", "windowName", "localDate", "windowStartsAt", "windowEndsAt", "status"],
    searchFields: ["windowName"],
    statuses: occurrenceStatusSchema.options,
    filters: ["action", "status", "search", "from", "to"],
    timeField: "windowStartsAt"
  }),
  define({
    name: "sleep-plans",
    singular: "sleep-plan",
    key: "sleepPlans",
    aliases: ["sleep"],
    columns: [
      "id",
      "plannedStartAt",
      "plannedWakeAt",
      "status",
      "allowedMinutes",
      "sleepDeficitMinutes",
      "explanation"
    ],
    searchFields: ["explanation"],
    statuses: sleepPlanStatusSchema.options,
    filters: ["status", "search", "from", "to"],
    timeField: "plannedStartAt"
  }),
  define({
    name: "spans",
    singular: "span",
    key: "spans",
    aliases: [],
    columns: ["id", "title", "startDate", "endDate", "window.localStartTime", "window.localEndTime", "projectId"],
    searchFields: ["title"],
    filters: ["project", "search"]
  }),
  define({
    name: "captures",
    singular: "capture",
    key: "captures",
    aliases: ["inbox"],
    columns: ["id", "text", "status", "proposalType", "createdAt"],
    searchFields: ["text"],
    statuses: captureStatusSchema.options,
    filters: ["status", "search", "since"],
    createdField: "createdAt"
  }),
  define({
    name: "conditions",
    singular: "condition",
    key: "conditionDefinitions",
    // Kept identical to `save`'s `condition_definition` entity type (save.ts) — accepting the singular
    // "place"/"condition-definition" here too, or `show place …` and `show condition-definition …` fail
    // even though `save place …` and `save condition-definition …` both work.
    aliases: ["places", "condition-definitions", "place", "condition-definition"],
    columns: ["id", "name", "kind", "status", "address", "travelMinutes"],
    searchFields: ["name", "address"],
    statuses: conditionStatusSchema.options,
    filters: ["status", "search"]
  }),
  define({
    name: "sessions",
    singular: "session",
    key: "completedToday",
    aliases: ["completed-today"],
    columns: ["id", "actionTitle", "result", "startedAt", "endedAt", "activeMinutes"],
    searchFields: ["actionTitle", "resultNote"],
    filters: ["action", "search", "from", "to"],
    timeField: "startedAt"
  }),
  define({
    name: "planning-focus",
    singular: "planning-focus",
    key: "planningFocus",
    aliases: ["focus"],
    columns: ["id", "kind", "periodStart", "periodEnd", "projectIds"],
    searchFields: [],
    filters: ["from", "to"],
    timeField: "periodStart"
  })
];

export function findEntity(name: string): EntityDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  return entityCatalogue.find(
    (entity) => entity.name === wanted || entity.singular === wanted || entity.aliases.includes(wanted)
  );
}

export function entityItems(state: PortalState, entity: EntityDefinition): AnyRecord[] {
  const value = state[entity.key];
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

export const entityNames = (): string[] => entityCatalogue.map((entity) => entity.name);
