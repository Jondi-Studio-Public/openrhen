import {
  importColumnFormat,
  importCsvEntities,
  importSpecs,
  type ImportColumnSpec,
  type ImportRelationSpec,
  type ImportTabSpec
} from "@/features/imports/import-spec";

/**
 * The template guide served at /import-template-guide.md, written from the import spec so the
 * columns, required marks and allowed values it lists are the ones the parser and validator use.
 * The checked-in copy under portal/public is asserted equal to this by import-guide.test.ts, which
 * also rewrites it when run with UPDATE_IMPORT_GUIDE=1.
 */
export function createImportTemplateGuide(): string {
  return [
    "# OpenRhen import template guide",
    "",
    "Use UTF-8 CSV. Keep the downloaded header names unchanged. Dates and timestamps use ISO 8601; a timestamp with an offset, for example `2026-08-20T17:00:00+10:00`, is exact, and one without an offset is read as your own timezone's clock. List values use `|`, for example `home|laptop`. Allowed booleans are `true` and `false`.",
    "",
    "`import_key` is required in every file. It is a stable, human-readable identifier containing up to 120 characters, such as `study`, `network-assignment`, or `draft-section-1`. Reusing the same entity type and key previews an update; a key the import has not seen before creates the record, and a record left out of a later file altogether is left unchanged. Relationship columns reference these keys, not database IDs.",
    "",
    "On an update, a blank cell clears the stored value — a list becomes empty — and a column left out of the file leaves it unchanged, so delete the columns you do not mean to change. A required column may therefore be omitted as a whole on an update, but never left blank.",
    "",
    ...importCsvEntities.flatMap((entity) => entitySection(entity, importSpecs[entity]!)),
    "## Confirmation rules",
    "",
    "Preview never changes planning data. Fix or remove every blocking record, save and validate the draft, then commit. Commit is one PostgreSQL transaction: if any reference, version, constraint, or dependency check fails, no planning record from the batch is written. You may instead commit only the ready rows; the blocked rows are moved into a new draft batch to fix later.",
    ""
  ].join("\n");
}

/** Prose that belongs to one entity's section rather than to any column. */
const ENTITY_NOTES: Record<string, { before?: string[]; after?: string[] }> = {
  deliverables: {
    before: [
      "Projects may contain actions, deliverable shells, or both. Use an action for ordinary directly executable work; use a deliverable when work must enter Breakdown, Carry out, Review only after the engine schedules it.",
      "This creates shell metadata only. It never creates completion criteria, BCR steps, evidence, reviews, or sessions."
    ]
  },
  deliverable_dependencies: { after: ["Deliverable dependencies must not reference themselves or create a cycle."] },
  actions: {
    after: [
      "Effort must satisfy optimistic ≤ expected ≤ pessimistic, remaining must be between 0 and pessimistic, and the minimum session must be positive and no greater than the maximum. Every condition named in `requirements` or `prefers` must exist in conditions.csv or the existing catalogue.",
      'A row with `repeat_every_days` is a cadence rather than a one-off: it is suggested every N days when there is time for it, ranked by how much it matters, and never turned into an appointment. Use it for "run every 3 days" or "practise maths daily" (daily = 1). The series starts the day you commit the import and ends only when you say so. A blank leaves the row an ordinary one-off and, on an update, leaves an existing cadence exactly as it stands — the one exception to the blank-clears rule above, so a sheet written before the column existed cannot quietly end a cadence. A 0 turns an existing cadence back into one-off work. Re-importing the same key changes the interval rather than restarting the cadence.'
    ]
  },
  dependencies: { after: ["Dependencies must not reference themselves or create a cycle."] },
  entity_prerequisites: {
    before: [
      "Every prerequisite edge that is not action-to-action (`dependencies.csv`) or deliverable-to-deliverable (`deliverable_dependencies.csv`): a project's, or one between different kinds. Put those same-kind edges on their own sheets; here they are refused."
    ],
    after: [
      "Entity prerequisites must not reference themselves or create a cycle. Include a row only after both ends exist in the reference or in this import; a row never removes a stored edge."
    ]
  },
  fixed_commitments: {
    before: [
      "Each row is one dated occurrence. For an appointment that repeats on a fixed interval use fixed_commitment_recurrences.csv instead."
    ]
  },
  fixed_commitment_recurrences: {
    before: [
      'Use this instead of fixed_commitments.csv for an appointment that repeats on a fixed interval (e.g. "every 2 weeks on Friday"). Committing a row creates a recurring rule; the plan automatically generates individual commitments for the current planning horizon and keeps generating them as the horizon rolls forward. To end a series, re-import the same import_key as a delete row — this stops future commitments without removing ones already in the past.'
    ]
  },
  contexts: {
    before: [
      "The typed context catalogue: the places you can be, the capabilities you can use, and the people you can reach. `import_key` is the context's own id and is what `requirements`, `prefers` and `grants` refer to. Capabilities are instances, not classes: `desktop` means that specific machine, not any computer."
    ],
    after: [
      "A blank status is stored as active and a blank portability as fixed. A composite capability's pathways must not reference itself, directly or through another composite."
    ]
  }
};

function entitySection(entity: string, spec: ImportTabSpec): string[] {
  const notes = ENTITY_NOTES[entity] ?? {};
  return [
    `## ${entity}.csv`,
    "",
    ...(notes.before ?? []).flatMap((line) => [line, ""]),
    "| Column | Required | Format or allowed values |",
    "|---|---:|---|",
    `| import_key | yes | ${spec.keyHelp} |`,
    ...spec.relations.map(relationRow),
    ...spec.columns.map(columnRow),
    "",
    ...(notes.after ?? []).flatMap((line) => [line, ""])
  ];
}

const relationRow = (relation: ImportRelationSpec) =>
  `| ${relation.header} | ${relation.required ? "yes" : "no"} | ${cell(relation.help ?? `${relation.targetType.replaceAll("_", " ")} import key`)} |`;

const columnRow = (column: ImportColumnSpec) =>
  `| ${column.header} | ${column.required ? "yes" : "no"} | ${cell(importColumnFormat(column))} |`;

/** A `|` inside a table cell would split it, even in a code span. */
const cell = (text: string) => text.replaceAll("|", "\\|");
