import { booleanOption, requirePositional, stringOption, type CommandSpec } from "../command.js";
import { entityItems, entityNames, findEntity, type AnyRecord, type EntityDefinition } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { restoreCallOf, restoreCallText } from "../closed-rows.js";
import type { AgentCall } from "@openrhen/contracts";
import { emitRows, getPath, type Emitter } from "../output.js";
import { outsideSourceOf } from "../outside-text.js";
import { selectRows, validateFilterOptions } from "../selection.js";

export const listCommand: CommandSpec = {
  name: "list",
  summary: "List entities of one kind, with filters",
  description:
    `Lists one kind of entity from the portal state: ${entityNames().join(", ")}. ` +
    "Filters that do not apply to the chosen entity are refused with the list of ones that do. " +
    "--project, --area, --outcome, --action, --commitment, and --preset accept an id or an exact title. " +
    "--where field=value (repeatable, dotted paths allowed, comma-separated values match any, " +
    "field!=value excludes; field<value, field>value, field<=value, and field>=value compare — a " +
    "date-shaped field compares as an instant, parsing the right side the way --from/--to do (so " +
    "field<today or field<+7d work), otherwise numerically when both sides are numbers, else lexically) " +
    "applies to every entity for filters not built in. --count summarises matching rows instead of " +
    "listing them. Tables truncate long text; --json never does, but a large result should still use " +
    "--limit/--offset, --fields, or --count to stay manageable, especially over MCP. The same filters, " +
    'selection code, and --where syntax are shared by "bulk", so a bulk --dry-run shows exactly the ' +
    "rows this would list. A closed row carries restore, the call that reopens it.",
  positionals: [{ name: "entity", required: true, description: "The entity kind to list, plural" }],
  options: {
    project: { type: "string", placeholder: "id|title", description: "Only items in this project" },
    area: { type: "string", placeholder: "id|name", description: "Only items in this area" },
    outcome: { type: "string", placeholder: "id|title", description: "Only items under this outcome" },
    action: { type: "string", placeholder: "id|title", description: "Only items of this action" },
    commitment: { type: "string", placeholder: "id|title", description: "Only items of this commitment" },
    preset: {
      type: "string",
      placeholder: "id|name",
      description:
        "Commitments only: only ones pinned directly to this routine preset (routineSource=preset) — a " +
        'place-inherited match needs "show routine-preset" instead, which can also resolve those'
    },
    status: { type: "string", placeholder: "a,b", description: "Only items in these statuses (comma separated)" },
    "scheduling-mode": {
      type: "string",
      placeholder: "a,b",
      description: "Actions only: only these scheduling modes (comma separated: one_off, recurring, cadence)"
    },
    where: {
      type: "string",
      multiple: true,
      placeholder: "field=value",
      description:
        "Extra filter on any field, repeatable: field=value, field!=value, or a comparison (field<value, " +
        "field>value, field<=value, field>=value); dotted paths allowed; comma-separated values on the " +
        "right of = or != match any of them"
    },
    search: {
      type: "string",
      placeholder: "text",
      description: "Case-insensitive match on the item's text fields; matches by words, best match first"
    },
    since: { type: "string", placeholder: "when", description: "Only items created at or after this time" },
    from: { type: "string", placeholder: "when", description: "Only items whose time is at or after this" },
    to: { type: "string", placeholder: "when", description: "Only items whose time is before this" },
    limit: { type: "string", mcp: { type: "integer", minimum: 1 }, placeholder: "n", description: "At most n rows" },
    offset: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "Skip the first n matching rows, after sorting"
    },
    sort: { type: "string", placeholder: "field", description: "Sort by a field; prefix with - for descending" },
    fields: {
      type: "string",
      placeholder: "a,b",
      description: "Columns or JSON fields to show (dotted paths allowed)"
    },
    count: {
      type: "boolean",
      description: "Count matching rows instead of listing them (grouped by --by, or a single total)"
    },
    by: { type: "string", placeholder: "field", description: "Field to group --count by; requires --count" }
  },
  mutates: false,
  examples: [
    "list actions --status planned,active --sort deadlineAt",
    'list actions --project "Thesis" --json',
    "list commitments --from today --to +7d",
    "list captures --status pending --fields id,text",
    "list actions --scheduling-mode recurring,cadence",
    "list actions --count --by schedulingMode",
    "list actions --where energy=high --where status!=done",
    'list actions --where "deadlineAt<+7d" --where importance>=4'
  ],
  async run(context, args) {
    const entityArg = requirePositional(listCommand, args, 0);
    const entity = findEntity(entityArg);
    if (!entity) throw new CliError(`Unknown entity "${entityArg}". Kinds: ${entityNames().join(", ")}.`, EXIT.usage);
    validateFilterOptions(entity, args.values);

    const state = await context.client.getState();
    const sort = stringOption(args.values, "sort");
    if (sort !== undefined) validateSortField(entity, entityItems(state, entity), sort);
    let rows = selectRows(state, entity, args.values, context.now());

    const byField = stringOption(args.values, "by");
    if (booleanOption(args.values, "count")) {
      emitCounts({ mode: context.mode, stdout: context.stdout }, rows, byField);
      return;
    }
    if (byField !== undefined) throw new CliError("--by only applies together with --count.", EXIT.usage);

    if (sort !== undefined) rows = sortRows(rows, sort);

    const offsetRaw = stringOption(args.values, "offset");
    if (offsetRaw !== undefined) {
      const offset = Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0)
        throw new CliError(`--offset must be a non-negative integer, got "${offsetRaw}".`, EXIT.usage);
      rows = rows.slice(offset);
    }

    const limitRaw = stringOption(args.values, "limit");
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0)
        throw new CliError(`--limit must be a positive integer, got "${limitRaw}".`, EXIT.usage);
      rows = rows.slice(0, limit);
    }

    // A closed row carries the call that reopens it (D17), whatever fields were asked for.
    const restores = new Map<unknown, AgentCall>();
    rows = rows.map((row) => {
      const call = restoreCallOf(entity.name, row);
      if (call === undefined) return row;
      restores.set(row.id, call);
      return { ...row, restore: call };
    });

    const fieldsRaw = stringOption(args.values, "fields");
    const fields = fieldsRaw ? fieldsRaw.split(",").map((field) => field.trim()) : undefined;
    // A narrowed row would lose where its text came from, which an agent's fence needs; ask for it back only
    // when some row came from outside, so a plan with none prints as before.
    if (fields && context.mode !== "table")
      for (const row of rows) {
        const source = outsideSourceOf(row);
        if (source === undefined) continue;
        const key = row.sourceType === source.type ? "sourceType" : "sources";
        if (!fields.includes(key)) fields.push(key);
      }

    if (fields && restores.size > 0 && context.mode !== "table" && !fields.includes("restore")) fields.push("restore");

    emitRows({ mode: context.mode, stdout: context.stdout }, rows, entity.columns, {
      fields,
      timeZone: state.settings.timezone
    });
    if (context.mode === "table")
      for (const [id, call] of restores)
        context.stdout(`${String(id)}: ${restoreCallText(call, context.mcp === true)}`);
  }
};

/** `--count`: a single `{count}` total, or one `{value, count}` row per distinct value of `--by`. */
function emitCounts(emitter: Emitter, rows: AnyRecord[], byField: string | undefined): void {
  if (byField === undefined) {
    emitRows(emitter, [{ count: rows.length }], ["count"]);
    return;
  }
  const counts = new Map<string, number>();
  // A group whose rows came from outside says so (JSON only), so its value can be fenced for an agent.
  const outside = new Map<string, string>();
  for (const row of rows) {
    const value = getPath(row, byField);
    const key = value === undefined || value === null ? "(none)" : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const source = outsideSourceOf(row);
    if (source !== undefined && !outside.has(key)) outside.set(key, source.type);
  }
  const withSource = emitter.mode !== "table";
  const countRows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({
      value,
      count,
      ...(withSource && outside.has(value) ? { sourceType: outside.get(value) } : {})
    }));
  emitRows(emitter, countRows, ["value", "count"]);
}

/**
 * Refuses a `--sort` field no record of the entity has, naming the fields that can be sorted on: an
 * unknown one would otherwise leave the rows in their stored order and look like it worked. The fields are
 * the entity's table columns plus every key any of its records carries (a dotted path is checked by its
 * first segment); only the plain-valued ones are listed in the message. With no records at all there is nothing to check against, so the sort is let through.
 */
function validateSortField(entity: EntityDefinition, all: readonly AnyRecord[], sortSpec: string): void {
  const field = sortSpec.startsWith("-") ? sortSpec.slice(1) : sortSpec;
  if (all.length === 0) return;
  const known = new Set<string>(entity.columns.map((column) => column.split(".")[0]!));
  const plain = new Set<string>();
  for (const item of all)
    for (const [key, value] of Object.entries(item)) {
      known.add(key);
      if (value === null || typeof value !== "object") plain.add(key);
    }
  if (field !== "" && known.has(field.split(".")[0]!)) return;
  const sortable = [...entity.columns, ...[...plain].filter((key) => !entity.columns.includes(key)).sort()];
  throw new CliError(`Cannot sort ${entity.name} by "${field}". Sortable fields: ${sortable.join(", ")}.`, EXIT.usage);
}

function sortRows(rows: AnyRecord[], sortSpec: string): AnyRecord[] {
  const descending = sortSpec.startsWith("-");
  const field = descending ? sortSpec.slice(1) : sortSpec;
  const withValue: AnyRecord[] = [];
  const withoutValue: AnyRecord[] = [];
  for (const row of rows) {
    const value = getPath(row, field);
    (value === undefined || value === null ? withoutValue : withValue).push(row);
  }
  withValue.sort((a, b) => compareValues(getPath(a, field), getPath(b, field)) * (descending ? -1 : 1));
  return [...withValue, ...withoutValue];
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
