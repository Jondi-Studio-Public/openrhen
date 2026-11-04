import { readFileSync } from "node:fs";
import {
  AGENT_PROPOSAL_PAYLOAD_MAX_CHARS,
  AGENT_PROPOSAL_SUMMARY_MAX,
  BULK_PROPOSAL_THRESHOLD
} from "@openrhen/contracts";
import type { PortalState } from "../client.js";
import {
  booleanOption,
  requirePositional,
  stringOption,
  type CommandContext,
  type CommandSpec,
  type OptionValues,
  type ParsedArgs
} from "../command.js";
import { entityCatalogue, entityItems, findEntity, type AnyRecord, type EntityDefinition } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { getPath, renderTable, toJson } from "../output.js";
import { normalizeForWrite } from "../read-to-write.js";
import { hasAnyFilterOption, selectRows, validateFilterOptions } from "../selection.js";
import {
  derivedEntityId,
  isFiledProposal,
  journalWrite,
  recordServerChecked,
  mergeAssignments,
  DRY_RUN_NOTICE,
  newCommandId,
  parseAssignments,
  readJsonFile,
  reportFiledProposal,
  sendCommand,
  stampCommandId,
  versionOf,
  type FiledProposal
} from "../write.js";
import {
  actionWithAssumedFields,
  buildWriteRequest,
  displayText,
  ENTITY_TYPES,
  humanLabel,
  reverseOfUpdate,
  withKnownFields,
  withKnownStatus,
  type EntityTypeDef
} from "./save.js";

type Fields = Record<string, unknown>;

/** The entity kinds `bulk` can update: every `list` kind whose `PortalState` array a `save` route also writes. */
function bulkEntityPairs(): { entity: EntityDefinition; saveDef: EntityTypeDef }[] {
  const pairs: { entity: EntityDefinition; saveDef: EntityTypeDef }[] = [];
  for (const entity of entityCatalogue) {
    const saveDef = ENTITY_TYPES.find((def) => def.arrayKey === entity.key);
    if (saveDef) pairs.push({ entity, saveDef });
  }
  return pairs;
}

export function bulkEntityNames(): string[] {
  return bulkEntityPairs().map((pair) => pair.entity.name);
}

interface Selected {
  id: string;
  existing: AnyRecord;
  expectedVersion: number | null;
}

interface Failure {
  id: string;
  reason: string;
  exitCode: number;
}

interface Prepared {
  id: string;
  existing: AnyRecord;
  /** The version the write was built against: the undo restates the record at it. */
  expectedVersion: number | null;
  patched: Fields;
  path: string;
  payload: Fields;
}

interface RecordResult {
  id: string;
  ok: boolean;
  /** True when the portal held this record's write for the owner instead of applying it. */
  proposed?: boolean;
  reason?: string;
  exitCode: number;
}

const EXIT_NAME: Record<number, string> = {
  [EXIT.ok]: "ok",
  [EXIT.usage]: "usage",
  [EXIT.validation]: "validation",
  [EXIT.conflict]: "conflict",
  [EXIT.notFound]: "not_found",
  [EXIT.unavailable]: "unavailable"
};

function exitName(code: number): string {
  return EXIT_NAME[code] ?? String(code);
}

/** Reads a `--targets`/`--targets-json` array of `{id, expectedVersion?}`, refusing anything else. */
function parseTargets(raw: unknown, source: string): { id: string; expectedVersion?: number | null }[] {
  if (!Array.isArray(raw))
    throw new CliError(`${source} must be a JSON array of {id, expectedVersion?} objects.`, EXIT.usage);
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new CliError(`${source}[${index}] must be an object with an "id".`, EXIT.usage);
    const record = item as Fields;
    if (typeof record.id !== "string" || record.id.length === 0)
      throw new CliError(`${source}[${index}] needs a string "id".`, EXIT.usage);
    const hasVersion = Object.hasOwn(record, "expectedVersion");
    if (hasVersion && record.expectedVersion !== null && typeof record.expectedVersion !== "number")
      throw new CliError(`${source}[${index}].expectedVersion must be a number or null.`, EXIT.usage);
    return hasVersion ? { id: record.id, expectedVersion: record.expectedVersion as number | null } : { id: record.id };
  });
}

function readJsonArrayFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT.usage);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
}

function parseInlineJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
}

/** Selects the records `bulk` will patch, from whichever one of the three selector modes was given. */
function selectTargets(
  state: PortalState,
  entity: EntityDefinition,
  values: OptionValues,
  now: Date
): { selected: Selected[]; failures: Failure[] } {
  const selected: Selected[] = [];
  const failures: Failure[] = [];

  const idsRaw = stringOption(values, "ids");
  const targetsPath = stringOption(values, "targets");
  const targetsJsonRaw = stringOption(values, "targets-json");

  if (idsRaw !== undefined) {
    const ids = [
      ...new Set(
        idsRaw
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      )
    ];
    if (ids.length === 0) throw new CliError("--ids needs at least one id.", EXIT.usage);
    const items = entityItems(state, entity);
    for (const id of ids) {
      const existing = items.find((item) => item.id === id);
      if (existing) selected.push({ id, existing, expectedVersion: versionOf(existing) });
      else failures.push({ id, reason: `No such ${entity.singular}.`, exitCode: EXIT.notFound });
    }
    return { selected, failures };
  }

  if (targetsPath !== undefined || targetsJsonRaw !== undefined) {
    const source = targetsJsonRaw !== undefined ? "--targets-json" : (targetsPath as string);
    const raw = targetsJsonRaw !== undefined ? parseInlineJson(targetsJsonRaw, source) : readJsonArrayFile(source);
    const targets = parseTargets(raw, source);
    if (targets.length === 0) throw new CliError(`${source} lists no targets.`, EXIT.usage);
    const items = entityItems(state, entity);
    for (const target of targets) {
      const existing = items.find((item) => item.id === target.id);
      if (!existing) {
        failures.push({ id: target.id, reason: `No such ${entity.singular}.`, exitCode: EXIT.notFound });
        continue;
      }
      const expectedVersion = Object.hasOwn(target, "expectedVersion")
        ? (target.expectedVersion ?? null)
        : versionOf(existing);
      selected.push({ id: target.id, existing, expectedVersion });
    }
    return { selected, failures };
  }

  validateFilterOptions(entity, values);
  for (const row of selectRows(state, entity, values, now)) {
    const id = typeof row.id === "string" ? row.id : String(row.id);
    selected.push({ id, existing: row, expectedVersion: versionOf(row) });
  }
  return { selected, failures };
}

/** Bounded-concurrency map: at most `limit` workers in flight, stopping early once `stopOnError` fires. */
async function runWithConcurrency<T, R extends { ok: boolean }>(
  items: T[],
  limit: number,
  stopOnError: boolean,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: (R | undefined)[] = Array.from<R | undefined>({ length: items.length });
  let cursor = 0;
  let stopped = false;
  async function pull(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      const result = await worker(item);
      results[index] = result;
      if (!result.ok && stopOnError) stopped = true;
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => pull());
  await Promise.all(workers);
  return results.filter((entry): entry is R => entry !== undefined);
}

function diffRow(item: Prepared, changedFields: string[]): Fields {
  const row: Fields = { id: item.id, title: displayText(item.existing) ?? displayText(item.patched) ?? "" };
  for (const field of changedFields) {
    row[`${field} before`] = getPath(item.existing, field);
    row[`${field} after`] = getPath(item.patched, field);
  }
  return row;
}

function printFailuresTable(context: CommandContext, failures: Failure[]): void {
  const rows = failures.map((failure) => ({
    id: failure.id,
    exitCode: exitName(failure.exitCode),
    reason: failure.reason
  }));
  context.stdout(renderTable(rows, ["id", "exitCode", "reason"]));
}

const COMMAND_FOR_PATH: Record<string, "save_entity" | "save_project" | "save_action"> = {
  "/api/commands/entity": "save_entity",
  "/api/commands/project": "save_project",
  "/api/commands/action": "save_action"
};

/** Files every prepared row as one `entity_command_batch` proposal, so the owner confirms them together. */
async function fileBatchProposal(
  context: CommandContext,
  args: ParsedArgs,
  label: string,
  changedFields: string[],
  prepared: Prepared[],
  unprepared: number
): Promise<void> {
  const commands = prepared.map((item) => {
    const command = COMMAND_FOR_PATH[item.path];
    if (!command) throw new CliError(`bulk cannot file ${item.path} as a proposal.`, EXIT.usage);
    // Each row keeps its own derived commandId, so confirming twice replays receipts instead of writing twice.
    return { command, body: stampCommandId(context, args, item.payload, item.id).payload };
  });
  const payload = { commands };
  if (JSON.stringify(payload).length > AGENT_PROPOSAL_PAYLOAD_MAX_CHARS)
    throw new CliError(
      `${prepared.length} rows are too large for one proposal (${AGENT_PROPOSAL_PAYLOAD_MAX_CHARS} characters); select fewer.`,
      EXIT.usage
    );
  const fields = changedFields.join(", ");
  const summary = `Bulk ${label}: update ${prepared.length} records (${fields})`.slice(0, AGENT_PROPOSAL_SUMMARY_MAX);
  context.stderr(
    `rhen: bulk ${label} — ${prepared.length} rows is over ${BULK_PROPOSAL_THRESHOLD}, so it goes to the owner as one proposal (Inbox > Captured > From agents)`
  );
  const response = await sendCommand<unknown>(
    context.client,
    "/api/agent-proposals",
    {
      kind: "entity_command_batch",
      summary,
      payload,
      commandId: derivedEntityId(context, args, "bulk-batch"),
      ...(stringOption(args.values, "basis") ? { basis: stringOption(args.values, "basis") } : {}),
      ...(stringOption(args.values, "evidence") ? { evidence: stringOption(args.values, "evidence") } : {})
    },
    undefined
  );
  if (!isFiledProposal(response)) throw new CliError("The portal did not file the batch proposal.", EXIT.unavailable);
  reportFiledProposal(context, response);
  if (unprepared > 0)
    context.stderr(`rhen: ${unprepared} record(s) could not be prepared and are not in the proposal.`);
}

export const bulkCommand: CommandSpec = {
  name: "bulk",
  summary: "Apply the same patch to many records at once",
  description:
    `Selects many records of one kind (${bulkEntityNames().join(", ")}) and applies one patch to each of ` +
    'them through the same validated write path "save" uses, one command per record. Selection is exactly ' +
    'one of: the "list" filters (--project, --area, --status, --where field=value/field!=value/field<value/' +
    'field>value, --search, --since/--from/--to, ...; run "rhen help list" for the full set), --ids ' +
    "a,b,c, or a targets list (--targets file.json or --targets-json '[...]', each entry {id, " +
    "expectedVersion?}; an entry with no expectedVersion reads the record's current version at selection " +
    "time, same as the filter and --ids forms). The patch is --set key=value (repeatable) and/or --patch " +
    "file.json. --dry-run prints the rows and fields that would change and sends nothing; otherwise --yes " +
    "is required. This is NOT atomic: each record is its own command with its own version check, so a " +
    "record changed since it was selected fails with a conflict while the rest still apply, and it prints " +
    "a compact summary plus a table of failures (id, exit-code category, reason) rather than N full " +
    "records — pass --verbose to see every result. Re-running the same command with the same selector is " +
    "safe: a record already patched either no longer matches the filter or fails its version check instead " +
    'of being silently overwritten again. Each row that applies is recorded for "undo" as its own ' +
    'write, labelled "bulk <kind>: <name>", so undo reverses them one at a time, newest first, each ' +
    "refused if that record was edited since; dry runs, failed rows and the over-20-row batch proposal " +
    "record nothing.",
  positionals: [
    {
      name: "entity",
      required: true,
      description: "The entity kind to update (see description for the supported kinds)"
    }
  ],
  options: {
    project: { type: "string", placeholder: "id|title", description: "Only items in this project" },
    area: { type: "string", placeholder: "id|name", description: "Only items in this area" },
    outcome: { type: "string", placeholder: "id|title", description: "Only items under this outcome" },
    action: { type: "string", placeholder: "id|title", description: "Only items of this action" },
    commitment: { type: "string", placeholder: "id|title", description: "Only items of this commitment" },
    preset: {
      type: "string",
      placeholder: "id|name",
      description: "Commitments only: pinned directly to this routine preset"
    },
    status: { type: "string", placeholder: "a,b", description: "Only items in these statuses (comma separated)" },
    "scheduling-mode": {
      type: "string",
      placeholder: "a,b",
      description: "Actions only: only these scheduling modes (comma separated)"
    },
    where: {
      type: "string",
      multiple: true,
      placeholder: "field=value",
      description: "Extra filter: field=value, field!=value, field<value, field>value, field<=value, or field>=value"
    },
    search: { type: "string", placeholder: "text", description: "Case-insensitive match on the item's text fields" },
    since: { type: "string", placeholder: "when", description: "Only items created at or after this time" },
    from: { type: "string", placeholder: "when", description: "Only items whose time is at or after this" },
    to: { type: "string", placeholder: "when", description: "Only items whose time is before this" },
    ids: {
      type: "string",
      placeholder: "a,b,c",
      description: "Comma-separated record ids to select, instead of filters"
    },
    targets: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: "JSON file of [{id, expectedVersion?}] to select, instead of filters or --ids"
    },
    "targets-json": {
      type: "string",
      mcp: { type: "array", items: "object" },
      placeholder: "json",
      description: "Inline JSON array of [{id, expectedVersion?}] (for callers without file access, e.g. over MCP)"
    },
    set: {
      type: "string",
      multiple: true,
      placeholder: "key=value",
      description: "Set one field on every selected record (repeatable)"
    },
    patch: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: "Read the patch fields from a JSON file; --set applies on top"
    },
    "dry-run": { type: "boolean", description: "Print the rows and fields that would change; send nothing" },
    yes: { type: "boolean", description: "Confirm the update (required unless --dry-run)" },
    concurrency: {
      type: "string",
      mcp: { type: "integer", minimum: 1 },
      placeholder: "n",
      description: "How many writes to run at once (default 4)"
    },
    "stop-on-error": { type: "boolean", description: "Stop at the first failed record instead of continuing" },
    verbose: { type: "boolean", description: "List every result, not just the failures" }
  },
  mutates: true,
  destructive: true,
  examples: [
    'bulk action --where "status=pending" --where "scheduledEnd<2026-09-04" --set status=skipped --dry-run',
    "bulk action --status planned --project Thesis --set energy=high --yes",
    "bulk capture --ids capture-a,capture-b --set status=ignored --yes",
    "bulk action --targets targets.json --set importance=2 --yes"
  ],
  async run(context, args) {
    const entityArg = requirePositional(bulkCommand, args, 0);
    const entity = findEntity(entityArg);
    if (!entity)
      throw new CliError(`Unknown entity "${entityArg}". Kinds: ${bulkEntityNames().join(", ")}.`, EXIT.usage);
    const saveDef = ENTITY_TYPES.find((def) => def.arrayKey === entity.key);
    if (!saveDef)
      throw new CliError(
        `bulk cannot update ${entity.name}; no write command updates it directly. Supported: ${bulkEntityNames().join(", ")}.`,
        EXIT.usage
      );

    const idsRaw = stringOption(args.values, "ids");
    const targetsPath = stringOption(args.values, "targets");
    const targetsJsonRaw = stringOption(args.values, "targets-json");
    if (targetsPath !== undefined && targetsJsonRaw !== undefined)
      throw new CliError("--targets and --targets-json cannot both be given.", EXIT.usage);
    const selectorCount = [
      hasAnyFilterOption(args.values),
      idsRaw !== undefined,
      targetsPath !== undefined || targetsJsonRaw !== undefined
    ].filter(Boolean).length;
    if (selectorCount === 0)
      throw new CliError(
        'bulk needs a selector: filters (see "rhen help list" for --project/--status/--where/...), ' +
          "--ids a,b,c, --targets file.json, or --targets-json '[...]'.",
        EXIT.usage
      );
    if (selectorCount > 1)
      throw new CliError(
        "bulk accepts only one selection method at a time: filters, --ids, or --targets/--targets-json.",
        EXIT.usage
      );

    const state = await context.client.getState();
    const { selected, failures } = selectTargets(state, entity, args.values, context.now());

    const patchPath = stringOption(args.values, "patch");
    const patchFileObj = patchPath ? readJsonFile(patchPath) : {};
    const setObj = parseAssignments(args.values, "set");
    const given = mergeAssignments(patchFileObj, setObj);
    if (Object.keys(given).length === 0)
      throw new CliError("bulk needs --set key=value and/or --patch file.json.", EXIT.usage);
    // The same field and status checks a single save makes, once for the whole patch.
    const patch = withKnownStatus(saveDef, withKnownFields(saveDef, given));

    const prepared: Prepared[] = [];
    for (const record of selected) {
      try {
        const merged = mergeAssignments(normalizeForWrite(saveDef.canonical, record.existing), patch);
        // An action's assumed fields follow what the patch names, as a single `save` does.
        const patched =
          saveDef.canonical === "action" ? actionWithAssumedFields(merged, record.existing, patch) : merged;
        const commandId = newCommandId();
        const { path, payload } = buildWriteRequest(saveDef, patched, commandId, record.expectedVersion);
        prepared.push({
          id: record.id,
          existing: record.existing,
          expectedVersion: record.expectedVersion,
          patched,
          path,
          payload
        });
      } catch (error) {
        if (error instanceof CliError)
          failures.push({ id: record.id, reason: error.message, exitCode: error.exitCode });
        else throw error;
      }
    }

    const label = humanLabel(saveDef.canonical);
    const changedFields = Object.keys(patch);
    const dryRun = booleanOption(args.values, "dry-run");
    const verbose = booleanOption(args.values, "verbose");

    if (dryRun) {
      context.stderr(
        `rhen: bulk ${label} — would update ${prepared.length} record(s), ${failures.length} would fail (dry run, nothing sent)`
      );
      if (context.mode !== "table") {
        context.stdout(
          toJson(
            {
              dryRun: true,
              ...DRY_RUN_NOTICE,
              entity: entity.name,
              count: prepared.length,
              wouldSucceed: prepared.map((item) => diffRow(item, changedFields)),
              wouldFail: failures
            },
            true
          )
        );
      } else {
        const columns = ["id", "title", ...changedFields.flatMap((field) => [`${field} before`, `${field} after`])];
        context.stdout(
          renderTable(
            prepared.map((item) => diffRow(item, changedFields)),
            columns
          )
        );
        if (failures.length > 0) {
          context.stdout("");
          context.stdout(`Would fail (${failures.length}):`);
          printFailuresTable(context, failures);
        }
        context.stdout("");
        context.stdout(`${prepared.length} would succeed, ${failures.length} would fail`);
      }
      if (failures.length > 0) context.setExitCode(failures.reduce((worst, item) => Math.max(worst, item.exitCode), 0));
      return;
    }

    if (!booleanOption(args.values, "yes"))
      throw new CliError(
        `This changes ${prepared.length + failures.length} record(s). Pass --yes to proceed, or --dry-run to preview.`,
        EXIT.usage
      );

    // Over the threshold an agent with a token does not write row by row: the portal would answer each row with
    // its own proposal. One batch proposal lists every row and is confirmed once (design section 2).
    if (context.hasToken === true && prepared.length > BULK_PROPOSAL_THRESHOLD) {
      await fileBatchProposal(context, args, label, changedFields, prepared, failures.length);
      return;
    }
    context.stderr(`rhen: bulk ${label} — updating ${prepared.length} record(s)`);

    const concurrencyRaw = stringOption(args.values, "concurrency");
    const concurrency = concurrencyRaw !== undefined ? Number(concurrencyRaw) : 4;
    if (!Number.isInteger(concurrency) || concurrency <= 0)
      throw new CliError(`--concurrency must be a positive integer, got "${concurrencyRaw}".`, EXIT.usage);
    const stopOnError = booleanOption(args.values, "stop-on-error");

    const writeResults = await runWithConcurrency<Prepared, RecordResult>(
      prepared,
      concurrency,
      stopOnError,
      async (item) => {
        try {
          // One id per record, derived from the run's key and the record's id, so repeating the bulk with
          // --command-id re-sends the same ids and the records that already landed are not applied again.
          const stamped = stampCommandId(context, args, item.payload, item.id);
          const response = await sendCommand<{ state?: PortalState } | FiledProposal>(
            context.client,
            item.path,
            stamped.payload,
            stamped.key
          );
          const proposed = isFiledProposal(response);
          // An applied row is journaled exactly as `save` journals the same edit (the record restated as it
          // was, version-checked), one entry per row; a row held as a proposal changed nothing, so has none.
          // One entry per command id: a row the portal kept images for is reverted by the portal; the rest are restated.
          if (
            !proposed &&
            recordServerChecked(context, response, {
              path: item.path,
              sent: stamped.payload,
              summary: `bulk ${label}: ${displayText(item.existing) ?? item.id}`,
              quiet: true
            })
          ) {
            // journaled
          } else if (
            !proposed &&
            response?.state &&
            typeof response.state === "object" &&
            item.patched.remove !== true
          ) {
            const reverse = reverseOfUpdate(saveDef, item.existing, item.expectedVersion, item.id);
            if (reverse)
              journalWrite(context, {
                state: response.state,
                sent: stamped.payload,
                path: item.path,
                summary: `bulk ${label}: ${displayText(item.existing) ?? item.id}`,
                reverse
              });
          }
          return { id: item.id, ok: true, exitCode: EXIT.ok, ...(proposed ? { proposed: true } : {}) };
        } catch (error) {
          const failure = error instanceof CliError ? error : new CliError(String(error), EXIT.unavailable);
          return { id: item.id, ok: false, reason: failure.message, exitCode: failure.exitCode };
        }
      }
    );

    const allFailures: Failure[] = [
      ...failures,
      ...writeResults
        .filter((result) => !result.ok)
        .map((result) => ({ id: result.id, reason: result.reason ?? "Failed.", exitCode: result.exitCode }))
    ];
    const succeededCount = writeResults.filter((result) => result.ok && !result.proposed).length;
    const proposedCount = writeResults.filter((result) => result.proposed).length;
    const skippedCount = prepared.length - writeResults.length; // left unattempted by --stop-on-error

    if (context.mode !== "table") {
      const allResults = [
        ...failures.map((failure) => ({
          id: failure.id,
          ok: false,
          exitCode: failure.exitCode,
          reason: failure.reason
        })),
        ...writeResults.map((result) => ({
          id: result.id,
          ok: result.ok,
          exitCode: result.exitCode,
          reason: result.reason
        }))
      ];
      context.stdout(
        toJson(
          {
            succeeded: succeededCount,
            proposed: proposedCount,
            failed: allFailures.length,
            skipped: skippedCount,
            results: verbose ? allResults : allResults.filter((result) => !result.ok)
          },
          true
        )
      );
    } else {
      context.stdout(
        `${succeededCount} succeeded, ${allFailures.length} failed` +
          (proposedCount > 0 ? `, ${proposedCount} filed as proposals for the owner` : "") +
          (skippedCount > 0 ? `, ${skippedCount} skipped` : "")
      );
      if (allFailures.length > 0) {
        context.stdout("");
        context.stdout(`Failed (${allFailures.length}):`);
        printFailuresTable(context, allFailures);
      }
      if (verbose) {
        context.stdout("");
        context.stdout("All results:");
        const rows = [
          ...failures.map((failure) => ({
            id: failure.id,
            status: "failed",
            exitCode: exitName(failure.exitCode),
            reason: failure.reason
          })),
          ...writeResults.map((result) => ({
            id: result.id,
            status: result.ok ? "ok" : "failed",
            exitCode: exitName(result.exitCode),
            reason: result.reason ?? ""
          }))
        ];
        context.stdout(renderTable(rows, ["id", "status", "exitCode", "reason"]));
      }
    }

    if (allFailures.length > 0)
      context.setExitCode(allFailures.reduce((worst, item) => Math.max(worst, item.exitCode), 0));
  }
};
