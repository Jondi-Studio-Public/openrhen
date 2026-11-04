import type {
  ActionStatus,
  EnergyType,
  ImportEntityType,
  LifecycleStatus,
  PlanItemType,
  PlanLinkKind,
  PrerequisiteKind
} from "@openrhen/contracts";

/**
 * The one description of what a workbook or CSV import may carry, per entity and per column. Every
 * other part of the import pipeline is derived from it: how a cell's text is read (`import-csv`),
 * what is required and which values are allowed (`import-validation`), what the review screen offers
 * for each field (`import-field-values`, `import-record-fields`), the headers and dropdowns of the
 * downloadable templates (`import-xlsx`, the CSV template route, `reference-pack`), and the field
 * guides written for people and external tools (`import-guide`, `reference-pack`). Add a column
 * here and each of those learns about it; there is deliberately nowhere else to list it.
 */
export type ImportColumnKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "time"
  | "enum"
  | "list"
  /** Weekday names ("Tue, Thu"), read as an ascending number[] with 0 = Sunday. */
  | "weekdays"
  /** Raw AND-within-`+`, OR-across-`|` groups, e.g. "desktop+online|laptop" -> [["desktop","online"],["laptop"]]. Used by a context definition's own composite pathways. */
  | "pathwayGroups"
  /** Same DSL as pathwayGroups, wrapped as { id, contextIds }[] for an action's requirement pathways. */
  | "requirementPathways";

export interface ImportColumnSpec {
  /** The header in a CSV or worksheet, e.g. `expected_minutes`. */
  header: string;
  /** The field name on the import record and in the portal state, e.g. `expectedMinutes`. */
  name: string;
  kind: ImportColumnKind;
  /** Required on a create. On an update an absent column is left alone; a blank cell still clears. */
  required?: boolean;
  /** The values an `enum` column accepts; also the workbook dropdown. */
  enum?: readonly string[];
  /** Suggested values offered as a workbook dropdown without being enforced (a `number` with common picks). */
  choices?: readonly string[];
  /** What "Apply default" fills in during review. Only fields listed here may be invented on the user's behalf. */
  default?: unknown;
  /** How the value is written, for the field guides. Enum columns need none: their values are the format. */
  help?: string;
  /** Rendered as a textarea in review — long free text rather than a one-line value. */
  multiline?: boolean;
  /** For a `list` of conditions, the review screen offers the condition catalogue as choices. */
  conditionList?: boolean;
}

export interface ImportRelationSpec {
  /** The header, e.g. `project_key`. */
  header: string;
  /** The relationship name on the record, e.g. `projectKey` — or the field name when `asField`. */
  name: string;
  /** Which entity the key names, so it can be checked against what exists. */
  targetType: ImportEntityType;
  /** Relationships carry no column provenance, so a required key is required on updates too. */
  required?: boolean;
  help?: string;
  /**
   * Carried as a record field of `name` rather than in `relationships`. A relationship is a bare
   * string: it cannot say whether the source carried the column at all, and it cannot carry the
   * evidence and confidence an extraction attaches to a value it proposed rather than read. An
   * optional key that must obey the absent-versus-blank rule on an update, and that a calendar
   * import offers as a guess for review, needs both — so it travels as a field and is resolved from
   * there. Everything else about it — header, guide entry, template column, target type, key
   * resolution — is unchanged.
   */
  asField?: boolean;
  /** For a `condition_definition` target, the kind of context the key must name. */
  targetConditionKind?: "location" | "capability" | "contact";
}

export interface ImportTabSpec {
  type: ImportEntityType;
  /** The worksheet name in the template workbook and reference pack. */
  sheetName: string;
  /** How the guide describes `import_key` for this entity. */
  keyHelp: string;
  relations: readonly ImportRelationSpec[];
  columns: readonly ImportColumnSpec[];
}

// `satisfies` rather than deriving from `lifecycleStatusSchema.options`: this module is imported by
// browser components (e.g. import-record-fields.tsx), and the package's main entry point builds
// every zod schema at module load — see the design notes on why client
// code imports `@openrhen/contracts/readiness` instead. A type-only import still fails the build
// the moment this list and the contract's `LifecycleStatus` diverge, at zero bundle cost.
const LIFECYCLE_STATUS = [
  "active",
  "paused",
  "done",
  "cancelled",
  "archived"
] as const satisfies readonly LifecycleStatus[];
/** Mirrors `PrerequisiteKind`; same-kind action and deliverable edges belong on their own sheets. */
const PREREQUISITE_KINDS = ["project", "deliverable", "action"] as const satisfies readonly PrerequisiteKind[];
const UNCERTAINTY = ["known", "some", "high"] as const;
// `satisfies` rather than deriving from `energyTypeSchema.options`: this module is imported by
// browser components (e.g. import-record-fields.tsx), and the package's main entry point builds
// every zod schema at module load — see the design notes on why client
// code imports `@openrhen/contracts/readiness` instead. A type-only import still fails the build
// the moment this list and the contract's `EnergyType` diverge, at zero bundle cost.
const ENERGY = ["high", "medium", "low", "recovery"] as const satisfies readonly EnergyType[];

// `satisfies` for the same reason as the lists above: these mirror `PLAN_ITEM_TYPES` and `PLAN_LINK_KINDS`.
const PLAN_LINK_END_TYPES = [
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "commitment",
  "contact",
  "place",
  "source",
  "subject"
] as const satisfies readonly PlanItemType[];
const PLAN_LINK_KINDS_LIST = [
  "about",
  "counts_toward",
  "prepares",
  "before",
  "occurrence_of",
  "involves",
  "references"
] as const satisfies readonly PlanLinkKind[];

const status = (values: readonly string[], fallback: string): ImportColumnSpec => ({
  header: "status",
  name: "status",
  kind: "enum",
  required: true,
  enum: values,
  default: fallback
});
const score = (header: string, name: string): ImportColumnSpec => ({
  header,
  name,
  kind: "number",
  required: true,
  default: 3,
  help: "Integer 1–5"
});
const buffers: readonly ImportColumnSpec[] = [
  {
    header: "setup_before_minutes",
    name: "setupBeforeMinutes",
    kind: "number",
    required: true,
    default: 0,
    help: "Integer 0 or greater"
  },
  {
    header: "transition_after_minutes",
    name: "transitionAfterMinutes",
    kind: "number",
    required: true,
    default: 0,
    help: "Integer 0 or greater"
  }
];
/**
 * Where a commitment happens, as a saved place rather than the free-text `location` label beside it.
 * Optional, and carried as a field so an update that leaves the column out keeps whatever place the
 * commitment already has (see `asField`).
 */
const commitmentLocation: ImportRelationSpec = {
  header: "location_key",
  name: "locationId",
  targetType: "condition_definition",
  asField: true,
  targetConditionKind: "location",
  help: "Key of a saved place; lets the planner work out the journey"
};
const timestamp = (header: string, name: string, help = "ISO timestamp"): ImportColumnSpec => ({
  header,
  name,
  kind: "datetime",
  help
});
const deadlines: readonly ImportColumnSpec[] = [
  timestamp("internal_deadline_at", "internalDeadlineAt", "ISO timestamp; not after external deadline"),
  timestamp("external_deadline_at", "externalDeadlineAt")
];

/** Keyed by the CSV template name, which is also the entity's name in a downloaded filename. */
export const importSpecs: Record<string, ImportTabSpec> = {
  areas: {
    type: "area",
    sheetName: "Areas",
    keyHelp: "Stable area key",
    relations: [],
    columns: [
      { header: "name", name: "name", kind: "text", required: true, help: "Unique area name" },
      { header: "description", name: "description", kind: "text", help: "Plain text" },
      status(LIFECYCLE_STATUS, "active"),
      {
        header: "sort_order",
        name: "sortOrder",
        kind: "number",
        required: true,
        default: 0,
        help: "Integer 0 or greater"
      }
    ]
  },
  outcomes: {
    type: "outcome",
    sheetName: "Outcomes",
    keyHelp: "Stable outcome key",
    relations: [
      {
        header: "area_key",
        name: "areaKey",
        targetType: "area",
        required: true,
        help: "`import_key` from areas.csv or a previously imported area"
      }
    ],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Outcome title" },
      {
        header: "definition_of_done",
        name: "definitionOfDone",
        kind: "text",
        required: true,
        help: "Observable completion condition"
      },
      score("value", "value"),
      status(LIFECYCLE_STATUS, "active"),
      timestamp("deadline_at", "deadlineAt"),
      { header: "review_on", name: "reviewOn", kind: "date", help: "ISO date, `YYYY-MM-DD`" }
    ]
  },
  projects: {
    type: "project",
    sheetName: "Projects",
    keyHelp: "Stable project key",
    relations: [
      { header: "outcome_key", name: "outcomeKey", targetType: "outcome", required: true, help: "Outcome import key" }
    ],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Project title" },
      status(LIFECYCLE_STATUS, "active"),
      { header: "uncertainty", name: "uncertainty", kind: "enum", required: true, enum: UNCERTAINTY, default: "some" },
      score("consequence", "consequence"),
      ...deadlines,
      {
        header: "remaining_effort_override_minutes",
        name: "remainingEffortOverrideMinutes",
        kind: "number",
        help: "Integer 0 or greater; leave blank unless intentionally overriding action-derived effort"
      }
    ]
  },
  deliverables: {
    type: "deliverable",
    sheetName: "Deliverables",
    keyHelp: "Stable deliverable key",
    relations: [
      { header: "project_key", name: "projectKey", targetType: "project", required: true, help: "Project import key" }
    ],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Deliverable title" },
      { header: "details", name: "details", kind: "text", help: "Brief or source context" },
      // Workbook imports create shells. BCR lifecycle states only begin when the user opens the
      // engine-recommended deliverable, so an import cannot pretend that breakdown has started.
      status(["needs_breakdown", "cancelled", "archived"], "needs_breakdown"),
      { header: "uncertainty", name: "uncertainty", kind: "enum", required: true, enum: UNCERTAINTY, default: "some" },
      score("importance", "importance"),
      score("consequence", "consequence"),
      ...deadlines
    ]
  },
  deliverable_dependencies: {
    type: "deliverable_dependency",
    sheetName: "Deliverable Dependencies",
    keyHelp: "Stable edge key",
    relations: [
      {
        header: "deliverable_key",
        name: "deliverableKey",
        targetType: "deliverable",
        required: true,
        help: "Blocked deliverable key"
      },
      {
        header: "depends_on_deliverable_key",
        name: "dependsOnDeliverableKey",
        targetType: "deliverable",
        required: true,
        help: "Prerequisite deliverable key"
      }
    ],
    columns: []
  },
  actions: {
    type: "action",
    sheetName: "Actions",
    keyHelp: "Stable action key",
    relations: [
      { header: "project_key", name: "projectKey", targetType: "project", required: true, help: "Project import key" }
    ],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Concrete action title" },
      status(
        [
          "inbox",
          "planned",
          "active",
          "doing",
          "waiting",
          "blocked",
          "done",
          "cancelled",
          "archived"
        ] as const satisfies readonly ActionStatus[],
        "active"
      ),
      {
        header: "optimistic_minutes",
        name: "optimisticMinutes",
        kind: "number",
        required: true,
        help: "Positive integer"
      },
      {
        header: "expected_minutes",
        name: "expectedMinutes",
        kind: "number",
        required: true,
        help: "Positive integer, at least optimistic"
      },
      {
        header: "pessimistic_minutes",
        name: "pessimisticMinutes",
        kind: "number",
        required: true,
        help: "Positive integer, at least expected"
      },
      {
        header: "remaining_minutes",
        name: "remainingMinutes",
        kind: "number",
        required: true,
        help: "Integer from 0 through pessimistic"
      },
      { header: "energy", name: "energy", kind: "enum", required: true, enum: ENERGY, default: "medium" },
      {
        header: "minimum_session_minutes",
        name: "minimumSessionMinutes",
        kind: "number",
        required: true,
        help: "Positive integer"
      },
      {
        header: "maximum_session_minutes",
        name: "maximumSessionMinutes",
        kind: "number",
        required: true,
        help: "Integer at least minimum session"
      },
      { header: "splittable", name: "splittable", kind: "boolean", required: true, default: true },
      {
        header: "setup_minutes",
        name: "setupMinutes",
        kind: "number",
        required: true,
        default: 0,
        help: "Integer 0 or greater"
      },
      score("importance", "importance"),
      score("consequence", "consequence"),
      // A cadence is an interval, not an appointment: the only thing a sheet has to say about it is
      // how often, so one optional number turns an ordinary action into one.
      {
        header: "repeat_every_days",
        name: "repeatEveryDays",
        kind: "number",
        help: "Cadence: suggest it every N days when time allows, ranked by importance; blank = one-off, and 0 turns an existing cadence back into one"
      },
      {
        header: "contexts",
        name: "contexts",
        kind: "list",
        conditionList: true,
        help: "Pipe-separated values, e.g. `home|laptop` — one AND pathway; prefer `requirements` for anything with alternatives. Ignored whenever the sheet has a `requirements` column at all."
      },
      {
        header: "requirements",
        name: "requirementPathways",
        kind: "requirementPathways",
        help: "Ways this action can be done: routes separated by `|`, each an AND of conditions joined by `+`, e.g. `desktop+online | campus`; blank means unconstrained"
      },
      {
        header: "prefers",
        name: "preferences",
        kind: "list",
        conditionList: true,
        help: "Pipe-separated conditions that improve ranking but never block eligibility, e.g. `home|quiet`"
      },
      timestamp("available_from", "availableFrom"),
      timestamp(
        "deadline_at",
        "deadlineAt",
        "ISO timestamp; blank means open — offered when there is slack, never overdue"
      ),
      timestamp("latest_start_at", "latestStartAt"),
      {
        header: "notes",
        name: "notes",
        kind: "text",
        multiline: true,
        help: "Free-text detail — exact steps, source links, or context to remember later"
      }
    ]
  },
  dependencies: {
    type: "dependency",
    sheetName: "Dependencies",
    keyHelp: "Stable edge key, e.g. `draft-after-research`",
    relations: [
      {
        header: "action_key",
        name: "actionKey",
        targetType: "action",
        required: true,
        help: "Dependent action import key"
      },
      {
        header: "depends_on_action_key",
        name: "dependsOnActionKey",
        targetType: "action",
        required: true,
        help: "Prerequisite action import key"
      }
    ],
    columns: []
  },
  entity_prerequisites: {
    type: "entity_prerequisite",
    sheetName: "Entity Prerequisites",
    keyHelp: "Stable edge key",
    // Not `relations`: each end names a project, deliverable or action by a kind column, so the key's
    // type is a cell, not the column. Resolution lives in key-resolution.ts.
    relations: [],
    columns: [
      {
        header: "entity_kind",
        name: "entityKind",
        kind: "enum",
        required: true,
        enum: PREREQUISITE_KINDS,
        help: "Kind of the blocked entity"
      },
      { header: "entity_key", name: "entityKey", kind: "text", required: true, help: "Blocked entity import key" },
      {
        header: "requires_kind",
        name: "requiresKind",
        kind: "enum",
        required: true,
        enum: PREREQUISITE_KINDS,
        help: "Kind of the prerequisite"
      },
      {
        header: "requires_key",
        name: "requiresKey",
        kind: "text",
        required: true,
        help: "Prerequisite import key"
      }
    ]
  },
  fixed_commitments: {
    type: "fixed_commitment",
    sheetName: "Fixed Commitments",
    keyHelp: "Stable commitment key",
    relations: [commitmentLocation],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Commitment title" },
      { header: "starts_at", name: "startsAt", kind: "datetime", required: true, help: "ISO timestamp" },
      { header: "ends_at", name: "endsAt", kind: "datetime", required: true, help: "ISO timestamp after starts_at" },
      status(["confirmed", "tentative", "cancelled"], "confirmed"),
      { header: "location", name: "location", kind: "text", help: "Plain text" },
      ...buffers
    ]
  },
  fixed_commitment_recurrences: {
    type: "fixed_commitment_recurrence",
    sheetName: "Recurring Commitments",
    keyHelp: "Stable rule key",
    relations: [commitmentLocation],
    columns: [
      { header: "title", name: "title", kind: "text", required: true, help: "Commitment title" },
      {
        header: "timezone",
        name: "timezone",
        kind: "text",
        required: true,
        help: "IANA timezone, e.g. Europe/London"
      },
      {
        header: "start_date",
        name: "startDate",
        kind: "date",
        required: true,
        help: "ISO date (YYYY-MM-DD) of the first occurrence"
      },
      { header: "end_date", name: "endDate", kind: "date", help: "ISO date; leave blank for an open-ended series" },
      {
        header: "interval_days",
        name: "intervalDays",
        kind: "number",
        help: "Integer > 0; every 2 weeks = 14, weekly = 7; required when interval_unit is days or blank"
      },
      {
        header: "interval_unit",
        name: "intervalUnit",
        kind: "enum",
        enum: ["days", "weeks", "months"],
        help: "days, weeks or months; blank defaults to days"
      },
      {
        header: "interval_weeks",
        name: "intervalWeeks",
        kind: "number",
        help: "Integer > 0; required when interval_unit is weeks (1 = every week, 2 = every fortnight)"
      },
      {
        header: "weekdays",
        name: "weekdays",
        kind: "weekdays",
        help:
          "Required when interval_unit is weeks: the days it falls on, e.g. `Tue, Thu`. Must include the weekday " +
          "of start_date"
      },
      {
        header: "interval_months",
        name: "intervalMonths",
        kind: "number",
        help: "Integer > 0; required when interval_unit is months"
      },
      {
        header: "month_anchor",
        name: "monthAnchor",
        kind: "enum",
        enum: ["day_of_month", "last_day", "nth_weekday", "last_weekday"],
        help:
          "Required when interval_unit is months. day_of_month = same day number each month (skipped when " +
          "the month is too short); last_day = the month's final day; nth_weekday = same week and weekday " +
          "each month; last_weekday = the last matching weekday of the month"
      },
      {
        header: "local_start_time",
        name: "localStartTime",
        kind: "time",
        required: true,
        help: "HH:MM, 24-hour clock"
      },
      {
        header: "local_end_time",
        name: "localEndTime",
        kind: "time",
        required: true,
        help: "HH:MM after local_start_time"
      },
      { header: "location", name: "location", kind: "text", help: "Plain text" },
      ...buffers
    ]
  },
  conditions: {
    type: "condition_definition",
    sheetName: "Conditions",
    keyHelp:
      "The condition's own id — a short, stable slug such as `home` or `desktop`, which requirements, prefers and grants reference",
    relations: [],
    columns: [
      { header: "name", name: "name", kind: "text", required: true, help: "Display name" },
      {
        header: "kind",
        name: "kind",
        kind: "enum",
        required: true,
        enum: ["location", "capability", "contact"],
        help: "What you assert (location), what you can use (capability), or who you can reach (contact)"
      },
      // Not required: the store defaults a blank to active, and to fixed, on a create.
      { header: "status", name: "status", kind: "enum", enum: ["active", "archived"], default: "active" },
      {
        header: "portability",
        name: "portability",
        kind: "enum",
        enum: ["fixed", "portable"],
        help: "Capability only; blank means fixed. A portable capability (a laptop, a phone) carries its own state through a location change"
      },
      {
        header: "grants",
        name: "grants",
        kind: "list",
        help: "Location only — a `|` list of fixed capability/contact import_keys normally available at this location"
      },
      {
        header: "pathways",
        name: "pathways",
        kind: "pathwayGroups",
        help: "Capability only — routes that make a composite capability available, in the same `+`/`|` syntax as requirements, e.g. `desktop+online | laptop+online`; blank means primitive"
      },
      {
        header: "travel_minutes",
        name: "travelMinutes",
        kind: "number",
        help: "Location only — typical minutes to get here from elsewhere; integer 0 or greater"
      },
      ...buffers.map((column) => ({
        ...column,
        required: false,
        help: "Location only — buffers around arriving and settling here; integer 0 or greater"
      })),
      {
        header: "channels",
        name: "channels",
        kind: "list",
        enum: ["in_person", "sync_remote", "async"],
        help: "Contact only — a `|` list from in_person, sync_remote, async"
      }
    ]
  },
  plan_links: {
    type: "plan_link",
    sheetName: "Plan Links",
    keyHelp:
      "Stable link key. Plan links are only ever created: a row that names a link you rejected, or an end that does not exist, is refused, and nothing here deletes a link",
    relations: [],
    columns: [
      {
        header: "from_type",
        name: "fromType",
        kind: "enum",
        required: true,
        enum: PLAN_LINK_END_TYPES,
        help: "What the link starts at"
      },
      { header: "from_id", name: "fromId", kind: "text", required: true, help: "The id of the item it starts at" },
      {
        header: "to_type",
        name: "toType",
        kind: "enum",
        required: true,
        enum: PLAN_LINK_END_TYPES,
        help: "What the link ends at"
      },
      { header: "to_id", name: "toId", kind: "text", required: true, help: "The id of the item it ends at" },
      {
        header: "kind",
        name: "kind",
        kind: "enum",
        required: true,
        enum: PLAN_LINK_KINDS_LIST,
        help: "How the two items relate"
      },
      { header: "weight", name: "weight", kind: "number", help: "Optional strength from 0 to 1" },
      {
        header: "evidence",
        name: "evidence",
        kind: "list",
        help: "Optional `|` list of short notes on why the two items belong together"
      }
    ]
  }
};

export const importCsvEntities = Object.keys(importSpecs);

/** The worksheet name each entity's rows live on, keyed by CSV template name. */
export const IMPORT_SHEET_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(importSpecs).map(([entity, spec]) => [entity, spec.sheetName])
);

/** The order entities are written on commit: every parent before the rows that point at it. */
export const IMPORT_ENTITY_ORDER = [
  "area",
  "outcome",
  "project",
  "condition_definition",
  "deliverable",
  "deliverable_dependency",
  "action",
  "dependency",
  // After every project, deliverable and action it can name.
  "entity_prerequisite",
  "fixed_commitment_recurrence",
  "fixed_commitment",
  // Last: a link may name an item the same batch has just written.
  "plan_link"
] as const satisfies readonly ImportEntityType[];

const specsByType = new Map(Object.values(importSpecs).map((spec) => [spec.type, spec]));

/** The spec for an entity type (`action`) rather than a template name (`actions`). */
export function importSpecForType(type: ImportEntityType): ImportTabSpec | undefined {
  return specsByType.get(type);
}

/** Every column a downloaded template for this entity carries, in the order the template writes them. */
export function importTemplateHeaders(entity: string): string[] {
  const spec = importSpecs[entity];
  return spec ? importSpecHeaders(spec) : [];
}

export function importSpecHeaders(spec: ImportTabSpec): string[] {
  return [
    "import_key",
    ...spec.relations.map((relation) => relation.header),
    ...spec.columns.map((column) => column.header)
  ];
}

export function importColumn(spec: ImportTabSpec, header: string): ImportColumnSpec | undefined {
  return spec.columns.find((column) => column.header === header);
}

/** The column spec behind a record field, by entity type and field name (`action`, `expectedMinutes`). */
export function importFieldSpec(type: ImportEntityType, name: string): ImportColumnSpec | undefined {
  return specsByType.get(type)?.columns.find((column) => column.name === name);
}

/**
 * The kind of a field by name alone, for the review screen's free-typed values, where an edit names
 * the field but the record's entity is not always at hand. Field names are consistent across
 * entities — `status` is an enum everywhere, `contexts` a list everywhere — which a test asserts.
 */
const kindsByName = new Map<string, ImportColumnKind>();
for (const spec of Object.values(importSpecs))
  for (const column of spec.columns) if (!kindsByName.has(column.name)) kindsByName.set(column.name, column.kind);
export function importFieldKind(name: string): ImportColumnKind {
  return kindsByName.get(name) ?? "text";
}

/** Fields required on a create, per entity type, in column order. */
export const REQUIRED_IMPORT_FIELDS: Record<ImportEntityType, string[]> = Object.fromEntries(
  [...specsByType].map(([type, spec]) => [
    type,
    spec.columns.filter((column) => column.required).map((column) => column.name)
  ])
) as Record<ImportEntityType, string[]>;

export const REQUIRED_RELATIONSHIPS: Partial<Record<ImportEntityType, string[]>> = Object.fromEntries(
  [...specsByType]
    .map(([type, spec]) => [
      type,
      spec.relations.filter((relation) => relation.required && !relation.asField).map((relation) => relation.name)
    ])
    .filter(([, names]) => (names as string[]).length)
);

/** Which entity each relationship column names, so a key can be checked against what exists. */
export const IMPORT_RELATION_TYPES: Partial<Record<string, ImportEntityType>> = Object.fromEntries(
  Object.values(importSpecs).flatMap((spec) =>
    spec.relations.filter((relation) => !relation.asField).map((relation) => [relation.name, relation.targetType])
  )
);

/** The relations an entity carries as record fields rather than in `relationships` (see `asField`). */
export function importFieldRelations(type: ImportEntityType): readonly ImportRelationSpec[] {
  return specsByType.get(type)?.relations.filter((relation) => relation.asField) ?? [];
}

/** The field-carried relation behind a record field, or undefined when the field is an ordinary column. */
export function importFieldRelation(type: ImportEntityType, name: string): ImportRelationSpec | undefined {
  return importFieldRelations(type).find((relation) => relation.name === name);
}

/** The values a workbook offers as a dropdown for this column, or undefined when it is free text. */
export function importColumnChoices(column: ImportColumnSpec): readonly string[] | undefined {
  if (column.kind === "enum") return column.enum;
  if (column.kind === "boolean") return ["true", "false"];
  return column.choices;
}

/** One line describing how a column's value is written, shared by every guide. */
export function importColumnFormat(column: ImportColumnSpec): string {
  if (column.kind === "enum" && column.enum) return column.enum.join(", ");
  if (column.help) return column.help;
  switch (column.kind) {
    case "boolean":
      return "true or false";
    case "number":
      return "Number";
    case "date":
      return "ISO date, `YYYY-MM-DD`";
    case "datetime":
      return "ISO timestamp";
    case "time":
      return "HH:MM, 24-hour clock";
    case "list":
      return "Pipe-separated values, e.g. `home|laptop`";
    case "weekdays":
      return "Weekday names separated by commas, e.g. `Tue, Thu`";
    case "pathwayGroups":
    case "requirementPathways":
      return "Routes separated by `|`, each an AND of conditions joined by `+`";
    default:
      return "Plain text";
  }
}
