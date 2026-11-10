import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  commitImportSchema,
  commitReadyImportSchema,
  previewImportSchema,
  updateImportSchema,
  type ImportBatch
} from "@openrhen/contracts";
import type { z } from "zod";
import {
  booleanOption,
  requirePositional,
  stringOption,
  type CommandContext,
  type ParsedArgs,
  type CommandSpec
} from "../command.js";
import { DRY_RUN_NOTICE, newCommandId } from "../write.js";
import { CliError, EXIT } from "../errors.js";
import { renderTable, toJson } from "../output.js";
import { SOURCE_NAMES_TEXT, isActivityImportSource, runActivityImport } from "./import-activity.js";

/** A batch summary row as `GET /api/imports` sends it (see portal/app/api/imports/route.ts). */
interface ImportBatchSummary {
  id: string;
  sourceType: string;
  inputKind: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  filename: string | null;
  recordCount: number;
  blockingCount: number;
}

const LIST_COLUMNS = ["id", "status", "sourceType", "inputKind", "recordCount", "blockingCount", "createdAt"];
const RECORD_COLUMNS = ["importKey", "entityType", "operation", "errors", "warnings"];

export const importCommand: CommandSpec = {
  name: "import",
  summary: "Bulk-create entities through the reviewed import flow",
  description:
    "Manages import batches: preview a file of records against the portal's validation, inspect or edit a " +
    "draft before committing it, and commit the records it approves into planning data. `preview` and " +
    "`update` read records from a `--from` file — either a full preview payload, `{records: [...]}`, or a " +
    "bare array — filling in schema defaults for anything left out.",
  positionals: [
    { name: "action", required: true, description: "list, preview, show, update, commit, or delete" },
    { name: "id", required: false, description: "batch id (show, update, commit, delete)" }
  ],
  options: {
    from: {
      type: "string",
      placeholder: "file",
      localPath: true,
      description: "JSON file of records (preview, update)"
    },
    kind: { type: "string", placeholder: "kind", description: "inputKind for preview (default planning_data)" },
    timezone: {
      type: "string",
      placeholder: "tz",
      description: "IANA timezone for preview (default: the portal's settings.timezone)"
    },
    "ready-only": {
      type: "boolean",
      description: "commit: only the records with no blockers; blocked ones move to a new draft batch"
    },
    source: { type: "string", placeholder: "name", description: "mail: the message@1 source to post to" },
    "max-message-mib": {
      type: "string",
      placeholder: "n",
      description: "mail: per-message size cap in MiB (default 128, at most 512)"
    },
    self: { type: "string", placeholder: "addresses", description: "mail: your own addresses, comma-separated" },
    "skip-unreadable": { type: "boolean", description: "mail: skip and name unreadable messages instead of stopping" },
    "dry-run": { type: "boolean", description: "Print the request instead of sending it" },
    yes: { type: "boolean", description: "Confirm a commit or delete" }
  },
  mutates: true,
  destructive: true,
  examples: [
    "import list",
    "import preview --from planning.json",
    "import preview --from records.json --kind task_list --timezone Europe/London --dry-run",
    "import show 3f2a1c4e-...",
    "import update 3f2a1c4e-... --from fixes.json",
    "import commit 3f2a1c4e-... --yes",
    "import commit 3f2a1c4e-... --ready-only --yes",
    "import delete 3f2a1c4e-... --yes",
    "import takeout C:\\Users\\you\\Documents\\data-exports\\takeout-001.zip",
    "import timeline C:\\Users\\you\\Documents\\data-exports\\Records.json --dry-run",
    "import spotify C:\\Users\\you\\Documents\\data-exports\\my_spotify_data.zip --dry-run",
    "import apple-health C:\\Users\\you\\Documents\\data-exports\\export.zip",
    "import mail C:\\Users\\you\\Documents\\mail\\archive.mbox --source my-mail-import --dry-run"
  ],
  async run(context, args) {
    const action = requirePositional(importCommand, args, 0);
    // `import <source> <path>` loads an export file into the activity store; it never touches the reviewed
    // batches below. It reads a local file, so it refuses over MCP (see runActivityImport).
    if (isActivityImportSource(action)) return runActivityImport(context, args);
    switch (action) {
      case "list":
        return runList(context);
      case "preview":
        return runPreview(context, args);
      case "show":
        return runShow(context, args);
      case "update":
        return runUpdate(context, args);
      case "commit":
        return runCommit(context, args);
      case "delete":
        return runDelete(context, args);
      default:
        throw new CliError(
          `Unknown import action "${action}". Actions: list, preview, show, update, commit, delete. To load a data export, name its source: ${SOURCE_NAMES_TEXT}.`,
          EXIT.usage
        );
    }
  }
};

async function runList(context: CommandContext): Promise<void> {
  const response = await context.client.get<{ batches: ImportBatchSummary[]; history: ImportBatchSummary[] }>(
    "/api/imports"
  );
  if (context.mode !== "table") {
    context.stdout(toJson(response, true));
    return;
  }
  context.stdout(renderTable(response.batches, LIST_COLUMNS));
  if (response.history.length > 0) {
    context.stdout("");
    context.stdout(`History (${response.history.length}):`);
    context.stdout(renderTable(response.history, LIST_COLUMNS));
  }
}

async function runShow(context: CommandContext, args: ParsedArgs): Promise<void> {
  const id = requireId(args);
  const response = await context.client.get<{ batch: ImportBatch }>(importPath(id));
  if (context.mode !== "table") {
    context.stdout(toJson(response, true));
    return;
  }
  renderBatch(context, response.batch);
}

async function runPreview(context: CommandContext, args: ParsedArgs): Promise<void> {
  const fromPath = stringOption(args.values, "from");
  if (!fromPath) throw new CliError("import preview needs --from <file>.", EXIT.usage);
  const payload = await buildPreviewPayload(context, fromPath, args);
  const parsed = previewImportSchema.safeParse(payload);
  if (!parsed.success) throw validationError(parsed.error);
  const summary = `Previews an import of ${parsed.data.records.length} record(s) as ${parsed.data.inputKind}.`;
  const result = await writeRequest<{ batch: ImportBatch; reopened: boolean }>(context, args, {
    method: "post",
    path: "/api/imports/preview",
    payload: parsed.data,
    summary
  });
  if (result === null) return;
  if (context.mode !== "table") {
    context.stdout(toJson(result, true));
    return;
  }
  renderBatch(context, result.batch);
}

async function runUpdate(context: CommandContext, args: ParsedArgs): Promise<void> {
  const id = requireId(args);
  const fromPath = stringOption(args.values, "from");
  if (!fromPath) throw new CliError("import update needs --from <file>.", EXIT.usage);
  const raw = readJsonAny(fromPath);
  const records = normaliseRecords(extractRecords(raw, fromPath));
  const current = await context.client.get<{ batch: ImportBatch }>(importPath(id));
  const payload = { expectedVersion: current.batch.version, records };
  const parsed = updateImportSchema.safeParse(payload);
  if (!parsed.success) throw validationError(parsed.error);
  const summary = `Updates import ${id} with ${parsed.data.records.length} record(s).`;
  const result = await writeRequest<{ batch: ImportBatch }>(context, args, {
    method: "put",
    path: importPath(id),
    payload: parsed.data,
    summary
  });
  if (result === null) return;
  if (context.mode !== "table") {
    context.stdout(toJson(result, true));
    return;
  }
  renderBatch(context, result.batch);
}

async function runCommit(context: CommandContext, args: ParsedArgs): Promise<void> {
  const id = requireId(args);
  const readyOnly = booleanOption(args.values, "ready-only");
  const current = await context.client.get<{ batch: ImportBatch }>(importPath(id));
  const summary = `Commits ${current.batch.records.length} record(s) into planning data.`;
  const payload = { expectedVersion: current.batch.version };
  const schema: z.ZodType = readyOnly ? commitReadyImportSchema : commitImportSchema;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw validationError(parsed.error);
  const path = readyOnly ? `${importPath(id)}/commit-ready` : `${importPath(id)}/commit`;
  const result = await writeRequest<{ batch: ImportBatch; deferred?: ImportBatch | null; state?: unknown }>(
    context,
    args,
    { method: "post", path, payload, summary, needsYes: summary }
  );
  if (result === null) return;
  if (context.mode !== "table") {
    context.stdout(toJson(result, true));
    return;
  }
  renderBatch(context, result.batch);
  if (readyOnly)
    context.stdout(
      result.deferred ? `Deferred batch: ${result.deferred.id}` : "Deferred batch: none (nothing was blocked)"
    );
  context.stdout("Portal state refreshed by the commit.");
}

async function runDelete(context: CommandContext, args: ParsedArgs): Promise<void> {
  const id = requireId(args);
  const summary = `Deletes draft import ${id}.`;
  const result = await writeRequest<{ deleted: boolean }>(context, args, {
    method: "del",
    path: importPath(id),
    summary,
    needsYes: summary
  });
  if (result === null) return;
  if (context.mode !== "table") {
    context.stdout(toJson(result, true));
    return;
  }
  context.stdout(`Deleted import ${id}.`);
}

// --- shared helpers --------------------------------------------------------------------------

function importPath(id: string): string {
  return `/api/imports/${id}`;
}

function requireId(args: ParsedArgs): string {
  const id = args.positionals[1];
  if (!id) throw new CliError(`Missing <id>. Run "rhen help import" for usage.`, EXIT.usage);
  return id;
}

function validationError(error: z.ZodError): CliError {
  return new CliError("Import payload failed contract validation.", EXIT.validation, error.issues.slice(0, 50));
}

/** Reads a `--from` file whose top level may be an object or a bare array (records files allow both). */
function readJsonAny(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${message(error)}`, EXIT.usage);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${message(error)}`, EXIT.usage);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pulls the records array out of a bare array, `{records: [...]}`, or a full preview/update payload. */
function extractRecords(raw: unknown, path: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).records))
    return (raw as Record<string, unknown>).records as unknown[];
  throw new CliError(`${path} must hold an array of records, or an object with a "records" array.`, EXIT.usage);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An already-shaped `ImportField` carries both `value` and `basis`; anything else is a bare value. */
function isShapedField(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && "value" in value && "basis" in value;
}

function normaliseFields(rawFields: unknown): Record<string, unknown> {
  if (!isPlainObject(rawFields)) return {};
  const fields: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(rawFields)) {
    fields[key] = isShapedField(raw)
      ? { confidence: null, evidence: [], needsReview: false, ...raw }
      : { value: raw, basis: "explicit", confidence: "high", evidence: [], needsReview: false };
  }
  return fields;
}

/** Fills every optional `ImportRecord` field the schema allows a caller to leave out. */
function normaliseRecord(raw: unknown, index: number): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new CliError(`Record at index ${index} must be an object.`, EXIT.usage);
  return {
    id: newCommandId(),
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: index,
    ...raw,
    fields: normaliseFields(raw.fields)
  };
}

function normaliseRecords(raw: unknown[]): Record<string, unknown>[] {
  return raw.map((entry, index) => normaliseRecord(entry, index));
}

/**
 * Builds the `previewImportSchema` payload from a `--from` file: a full preview object, `{records}`,
 * or a bare array. File-declared fields win over built-in defaults but lose to explicit flags; the
 * timezone falls back to the portal's own settings when neither the flag nor the file names one.
 */
async function buildPreviewPayload(
  context: CommandContext,
  path: string,
  args: ParsedArgs
): Promise<Record<string, unknown>> {
  const raw = readJsonAny(path);
  const fileObject = isPlainObject(raw) ? raw : {};
  const records = extractRecords(raw, path);

  const kindOption = stringOption(args.values, "kind");
  const timezoneOption = stringOption(args.values, "timezone");

  const sourceType = typeof fileObject.sourceType === "string" ? fileObject.sourceType : "fixture";
  const inputKind = kindOption ?? (typeof fileObject.inputKind === "string" ? fileObject.inputKind : "planning_data");
  let timezone = timezoneOption ?? (typeof fileObject.timezone === "string" ? fileObject.timezone : undefined);
  if (!timezone) {
    const state = await context.client.getState();
    timezone = state.settings.timezone;
  }
  const fileSource = isPlainObject(fileObject.source) ? fileObject.source : {};

  return {
    sourceType,
    inputKind,
    timezone,
    templateVersion: "1",
    records: normaliseRecords(records),
    source: { filename: basename(path), ...fileSource }
  };
}

/** id, status, and a per-record table with every error and warning spelled out beneath it. */
function renderBatch(context: CommandContext, batch: ImportBatch): void {
  const lines = [
    `id: ${batch.id}`,
    `status: ${batch.status}`,
    `sourceType: ${batch.sourceType}  inputKind: ${batch.inputKind}  version: ${batch.version}`,
    ""
  ];
  const rows = batch.records.map((record) => ({
    importKey: record.importKey,
    entityType: record.entityType,
    operation: record.operation,
    errors: record.errors.length,
    warnings: record.warnings.length
  }));
  lines.push(renderTable(rows, RECORD_COLUMNS));
  const problems = batch.records.flatMap((record) => [
    ...record.errors.map((error) => `  [${record.importKey}] error: ${error}`),
    ...record.warnings.map((warning) => `  [${record.importKey}] warning: ${warning}`)
  ]);
  if (problems.length > 0) lines.push("", ...problems);
  context.stdout(lines.join("\n"));
}

interface WriteOptions {
  method: "post" | "put" | "del";
  path: string;
  payload?: Record<string, unknown>;
  summary: string;
  needsYes?: string;
}

/**
 * The write path for every import mutation: refuses without `--yes` when `needsYes` is set, echoes a
 * one-line summary to stderr, prints `{dryRun, path, payload}` and stops under `--dry-run`, otherwise
 * sends the request. Returns null exactly when `--dry-run` stopped the request.
 */
async function writeRequest<T>(context: CommandContext, args: ParsedArgs, options: WriteOptions): Promise<T | null> {
  if (options.needsYes && !booleanOption(args.values, "yes"))
    throw new CliError(`${options.needsYes} Pass --yes to proceed.`, EXIT.usage);
  context.stderr(`rhen: ${options.summary}`);
  if (booleanOption(args.values, "dry-run")) {
    context.stdout(
      toJson({ dryRun: true, ...DRY_RUN_NOTICE, path: options.path, payload: options.payload ?? {} }, true)
    );
    return null;
  }
  if (options.method === "post") return context.client.post<T>(options.path, options.payload ?? {});
  if (options.method === "put") {
    if (!context.client.put) throw new CliError("This client cannot send PUT requests.", EXIT.unavailable);
    return context.client.put<T>(options.path, options.payload ?? {});
  }
  if (!context.client.del) throw new CliError("This client cannot send DELETE requests.", EXIT.unavailable);
  return context.client.del<T>(options.path);
}
