import {
  ENTITY_FIELD_SCHEMAS,
  SAVE_ENTITY_KINDS,
  activityCommandSchema,
  blockerReportSchema,
  blockerResolutionSchema,
  checkInCommandSchema,
  criterionReviewSchema,
  endRecurrenceGoalCommandSchema,
  handoffRequestSchema,
  importBatchSchema,
  planExtensionSchema,
  planningEntityCommandSchema,
  planningRuntimeStateSchema,
  portalStateSchema,
  previewImportSchema,
  recalculateCommandSchema,
  recordCadenceCompletionCommandSchema,
  saveActionCommandSchema,
  saveCommitmentRecurrenceRuleCommandSchema,
  saveProjectCommandSchema,
  sessionCommandSchema,
  workspaceAdditionSchema,
  workspaceToolCallSchema
} from "@openrhen/contracts";
import { z } from "zod";
import { booleanOption, type CommandSpec } from "../command.js";
import { entityCatalogue, entityNames, findEntity } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface NamedSchema {
  name: string;
  /** Printed as the schema's `title`, so the output says what it is without reading source. */
  title: string;
  /** `"input"` for a command payload, so a default appears optional the way a sender sees it. */
  io: "input" | "output";
  /** Most entries: a zod schema run straight through `generateJsonSchema`. */
  schema?: z.ZodType;
  /** For names that pull one property back out of a bigger generated schema instead (e.g. settings). */
  resolve?: () => JsonRecord;
}

/**
 * Resolved before an entity kind: the exact body a write command sends, and the two whole-document
 * schemas. `state` and `planning` are not commands, but they share this lookup because both are
 * named the same way a command is — one word, resolved before falling back to the entity catalogue.
 */
const namedSchemas: NamedSchema[] = [
  { name: "session", title: "session (command payload)", schema: sessionCommandSchema, io: "input" },
  { name: "activity", title: "activity (command payload)", schema: activityCommandSchema, io: "input" },
  { name: "entity", title: "entity (command payload)", schema: planningEntityCommandSchema, io: "input" },
  { name: "project", title: "project (command payload)", schema: saveProjectCommandSchema, io: "input" },
  { name: "action", title: "action (command payload)", schema: saveActionCommandSchema, io: "input" },
  { name: "check-in", title: "check-in (command payload)", schema: checkInCommandSchema, io: "input" },
  { name: "recalculate", title: "recalculate (command payload)", schema: recalculateCommandSchema, io: "input" },
  {
    name: "cadence",
    title: "cadence (command payload)",
    schema: recordCadenceCompletionCommandSchema,
    io: "input"
  },
  {
    name: "recurrence",
    title: "recurrence (command payload)",
    schema: saveCommitmentRecurrenceRuleCommandSchema,
    io: "input"
  },
  {
    name: "recurrence-goal",
    title: "recurrence-goal (command payload)",
    schema: endRecurrenceGoalCommandSchema,
    io: "input"
  },
  { name: "import-preview", title: "import-preview (command payload)", schema: previewImportSchema, io: "input" },
  { name: "import-batch", title: "import-batch (command payload)", schema: importBatchSchema, io: "input" },
  {
    name: "deliverable-addition",
    title: "deliverable-addition (the --from payload for `deliverable add-to-breakdown`)",
    schema: workspaceAdditionSchema,
    io: "input"
  },
  {
    name: "deliverable-plan-extension",
    title: "deliverable-plan-extension (the --from payload for `deliverable extend-plan`)",
    schema: planExtensionSchema,
    io: "input"
  },
  {
    name: "deliverable-review",
    title: "deliverable-review (the --from payload for `deliverable record-review`)",
    schema: criterionReviewSchema,
    io: "input"
  },
  {
    name: "deliverable-blocker",
    title: "deliverable-blocker (the `deliverable record-blocker` payload)",
    schema: blockerReportSchema,
    io: "input"
  },
  {
    name: "deliverable-blocker-resolution",
    title: "deliverable-blocker-resolution (the `deliverable resolve-blocker` payload)",
    schema: blockerResolutionSchema,
    io: "input"
  },
  {
    name: "workspace-move",
    title: "workspace-move (POST /api/deliverables/[id]/workspace's `call` field)",
    schema: workspaceToolCallSchema,
    io: "input"
  },
  // What `save <kind>` takes: the fields a caller may give (an update gives only what changes).
  ...SAVE_ENTITY_KINDS.map((kind): NamedSchema => ({
    name: `save-${kind.replace(/_/g, "-")}`,
    title: `save ${kind.replace(/_/g, " ")} (the fields \`save\` takes)`,
    schema: ENTITY_FIELD_SCHEMAS[kind],
    io: "input"
  })),
  {
    name: "handoff",
    title: "handoff (POST /api/deliverables/[id]/handoff payload)",
    schema: handoffRequestSchema,
    io: "input"
  },
  { name: "state", title: "state (the whole portal state document)", schema: portalStateSchema, io: "output" },
  {
    name: "planning",
    title: "planning (the engine's latest planning result)",
    schema: planningRuntimeStateSchema,
    io: "output"
  },
  {
    name: "settings",
    title: "settings (portal settings)",
    io: "output",
    // Not its own export in @openrhen/contracts: `settings` is one object property inside
    // portalStateSchema, so it is pulled back out of the generated state schema rather than run
    // through generateJsonSchema on its own.
    resolve: () => objectPropertyJsonSchema("settings", "settings")
  }
];

function findNamedSchema(name: string): NamedSchema | undefined {
  const wanted = name.trim().toLowerCase();
  return namedSchemas.find((entry) => entry.name === wanted);
}

/** Runs `z.toJSONSchema`, and if the construct trips the generator, retries with the other `io`. */
function generateJsonSchema(schema: z.ZodType, io: "input" | "output", what: string): JsonRecord {
  const attempt = (mode: "input" | "output") =>
    mode === "input"
      ? // oxlint-disable-next-line import/namespace -- zod 4 exports toJSONSchema; the import resolver reads the bundled v3 namespace
        z.toJSONSchema(schema, { unrepresentable: "any", io: "input" })
      : // oxlint-disable-next-line import/namespace -- zod 4 exports toJSONSchema; the import resolver reads the bundled v3 namespace
        z.toJSONSchema(schema, { unrepresentable: "any" });
  try {
    return attempt(io) as JsonRecord;
  } catch (primaryError) {
    try {
      return attempt(io === "input" ? "output" : "input") as JsonRecord;
    } catch {
      const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new CliError(`Cannot derive a JSON schema for ${what}: ${reason}`, EXIT.unavailable);
    }
  }
}

/** A handful of state properties are `{ anyOf: [<schema>, { type: "null" }] }`; take the real branch. */
function unwrapNullable(property: JsonRecord): JsonRecord {
  if (!Array.isArray(property.anyOf)) return property;
  const branch = (property.anyOf as unknown[]).find(
    (candidate): candidate is JsonRecord => isJsonRecord(candidate) && candidate.type !== "null"
  );
  return branch ?? property;
}

/** Pulls one entity kind's element schema out of the whole state schema, by property name. */
function entityJsonSchema(entityKey: string, entityLabel: string): JsonRecord {
  const stateSchema = generateJsonSchema(portalStateSchema, "output", "the portal state");
  const properties = isJsonRecord(stateSchema.properties) ? stateSchema.properties : undefined;
  const rawProperty = properties?.[entityKey];
  if (!isJsonRecord(rawProperty))
    throw new CliError(`The portal state schema has no "${entityKey}" property.`, EXIT.unavailable);
  const arraySchema = unwrapNullable(rawProperty);
  if (arraySchema.type !== "array" || !isJsonRecord(arraySchema.items))
    throw new CliError(`"${entityLabel}" is not an array of records in the portal state schema.`, EXIT.unavailable);
  return arraySchema.items;
}

/** Pulls one plain-object (not array) property out of the whole state schema, by property name. */
function objectPropertyJsonSchema(propertyKey: string, propertyLabel: string): JsonRecord {
  const stateSchema = generateJsonSchema(portalStateSchema, "output", "the portal state");
  const properties = isJsonRecord(stateSchema.properties) ? stateSchema.properties : undefined;
  const rawProperty = properties?.[propertyKey];
  if (!isJsonRecord(rawProperty))
    throw new CliError(`The portal state schema has no "${propertyKey}" property.`, EXIT.unavailable);
  const objectSchema = unwrapNullable(rawProperty);
  if (objectSchema.type !== "object")
    throw new CliError(`"${propertyLabel}" is not an object in the portal state schema.`, EXIT.unavailable);
  return objectSchema;
}

/** Adds a `title` naming what the schema describes, without disturbing an object the caller already titled. */
function withTitle(schema: JsonRecord, title: string): JsonRecord {
  return { title, ...schema };
}

function listing() {
  return { commands: namedSchemas.map((entry) => entry.name), entities: entityCatalogue.map((entity) => entity.name) };
}

function renderListing(mode: "table" | "json" | "jsonl", stdout: (text: string) => void): void {
  if (mode === "table") {
    const { commands, entities } = listing();
    stdout(
      [
        "Command payloads and documents:",
        ...commands.map((name) => `  ${name}`),
        "",
        "Entities:",
        ...entities.map((name) => `  ${name}`)
      ].join("\n")
    );
    return;
  }
  stdout(toJson(listing(), mode === "json"));
}

export const schemaCommand: CommandSpec = {
  name: "schema",
  summary: "Print the JSON schema of an entity or a command payload",
  description:
    "Derives a JSON schema from the shared contracts, so a tool can learn the exact fields of an entity or the " +
    "exact body a write command sends without reading source. A name resolves first against the command " +
    "payloads and the whole-document schemas (session, activity, entity, project, action, check-in, " +
    "recalculate, cadence, recurrence, recurrence-goal, import-preview, import-batch, deliverable-addition, " +
    "deliverable-plan-extension, deliverable-review, deliverable-blocker, deliverable-blocker-resolution, " +
    "workspace-move, handoff, state, planning, settings, and save-<kind> for the fields `save <kind>` takes, " +
    "such as save-commitment or save-routine-step), then " +
    "against an entity kind: `schema action` is the save-action command's payload, `schema actions` is the " +
    "action entity itself. With no name, or --list, lists what is available.",
  positionals: [{ name: "name", required: false, description: "A command payload, document, or entity kind" }],
  options: { list: { type: "boolean", description: "List the available names instead of resolving one" } },
  mutates: false,
  offline: true,
  examples: [
    "schema",
    "schema --list --json",
    "schema actions",
    "schema action",
    "schema session",
    "schema state",
    "schema planning --pretty"
  ],
  async run(context, args) {
    const name = args.positionals[0];
    if (name === undefined || booleanOption(args.values, "list")) {
      renderListing(context.mode, context.stdout);
      return;
    }
    const named = findNamedSchema(name);
    if (named) {
      const generated = named.resolve
        ? named.resolve()
        : generateJsonSchema(named.schema as z.ZodType, named.io, `"${named.name}"`);
      context.stdout(toJson(withTitle(generated, named.title), true));
      return;
    }
    const entity = findEntity(name);
    if (entity) {
      const generated = entityJsonSchema(entity.key, entity.name);
      context.stdout(toJson(withTitle(generated, `${entity.singular} (entity)`), true));
      return;
    }
    throw new CliError(
      `Unknown schema name "${name}". Command payloads and documents: ${namedSchemas.map((entry) => entry.name).join(", ")}. ` +
        `Entities: ${entityNames().join(", ")}.`,
      EXIT.usage
    );
  }
};
