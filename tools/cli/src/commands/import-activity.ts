import { basename } from "node:path";
import {
  IMPORT_SOURCES,
  ImportReadError,
  isImportSource,
  planImport,
  type ActivityEventDraft,
  type EventJob,
  type ImportPlan,
  type ImportSourceName,
  type YoutubeJob
} from "@openrhen/activity-importers";
import {
  ACTIVITY_FILENAME_MAX_CHARS,
  ACTIVITY_MAX_BATCH,
  WATCH_IMPORT_MAX_FILE_BYTES,
  type WatchImportResult
} from "@openrhen/contracts";
import { booleanOption, type CommandContext, type ParsedArgs } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";

/**
 * `rhen import <source> <path>`: reads an export on this machine, parses it with the streaming importers, and posts
 * the events in batches to `POST /api/activity-events`, the one write path every activity source shares. The
 * file never goes to the portal as a whole: only parsed events do, so a multi-gigabyte Takeout or Apple Health
 * export is fine. YouTube history is the one exception, sent to the existing watch-history route.
 */

/** A batch is held under the route's 2 MB body limit with room for the envelope. */
const BATCH_BYTES = 1_500_000;
/** One event over this size is dropped and counted: a real event is far smaller, and the batch limit is 2 MB. */
const MAX_EVENT_BYTES = 1_000_000;
const REASON_GROUPS_SHOWN = 15;

interface BatchResponse {
  added: number;
  alreadyHeld: number;
  contentDropped: number;
  rejected: { index: number; reason: string }[];
  importId: string | null;
  message?: string;
}

interface HeldResponse {
  held: boolean;
  importId?: string;
  eventCount?: number;
}

interface RejectionGroup {
  reason: string;
  count: number;
  firstEvent: number;
}

export interface SourceSummary {
  source: string;
  files: string[];
  status: "imported" | "already-held" | "dry-run";
  read: number;
  sent: number;
  added: number;
  alreadyHeld: number;
  contentDropped: number;
  rejected: number;
  rejections: RejectionGroup[];
  skipped: number;
  ignored: number;
  skippedReasons: Record<string, number>;
  /** The commonest first words of skipped titles (My Activity), most frequent first. */
  skippedVerbs: Record<string, number>;
  truncated: boolean;
  /** Set when the run looks like a failure that exit code 0 would hide: no events, or most rows skipped. */
  warning?: string;
  importId: string | null;
}

export const SOURCE_NAMES_TEXT = IMPORT_SOURCES.join(", ");

export function isActivityImportSource(value: string): value is ImportSourceName {
  return isImportSource(value);
}

export async function runActivityImport(context: CommandContext, args: ParsedArgs): Promise<void> {
  if (context.mcp || context.remote)
    throw new CliError(
      "Importing an export reads a file on this machine, so it runs only from the command line (rhen import <source> <path>), not over MCP.",
      EXIT.usage
    );
  const source = args.positionals[0] as ImportSourceName;
  const path = args.positionals[1];
  if (!path)
    throw new CliError(
      `Missing <path>. Usage: rhen import ${source} <path to the export file, zip or folder>. Sources: ${SOURCE_NAMES_TEXT}.`,
      EXIT.usage
    );
  const dryRun = booleanOption(args.values, "dry-run");
  const again = booleanOption(args.values, "yes");
  let plan: ImportPlan;
  try {
    plan = await planImport(source, path);
  } catch (error) {
    if (error instanceof ImportReadError) throw new CliError(error.message, EXIT.usage);
    throw error;
  }
  for (const note of plan.notes) context.stderr(`rhen: ${note}`);

  const summaries: SourceSummary[] = [];
  const youtube: { file: string; result: WatchImportResult | null; dryRun: boolean }[] = [];
  const failures: JobFailure[] = [];
  const poster = runPoster(context);
  // One job failing (a damaged file, a refused batch) must not hide the others: every job gets its turn and its
  // own run row, and the command exits non-zero at the end if any failed.
  for (const job of plan.jobs) {
    const startedAt = context.now();
    const source = job.kind === "youtube" ? YOUTUBE_RUN_SOURCE : job.source;
    const partial = job.kind === "youtube" ? undefined : newSummary(job, dryRun);
    try {
      if (job.kind === "youtube") {
        const item = await runYoutube(context, job, path, dryRun);
        youtube.push(item);
        if (!dryRun && item.result) await poster.post(youtubeRun(source, job, item.result, startedAt, context.now()));
      } else {
        const summary = await runEvents(context, plan, job, path, { dryRun, again }, partial!);
        summaries.push(summary);
        if (summary.status === "imported") await poster.post(eventsRun(source, summary, startedAt, context.now()));
      }
    } catch (error) {
      const failure = error instanceof ImportReadError ? new CliError(error.message, EXIT.usage) : error;
      failures.push({ source, error: failure });
      if (!dryRun)
        await poster.post(failedRun(source, job, partial, failure, [path, ...jobFiles(job)], startedAt, context.now()));
    }
  }

  if (context.mode !== "table") context.stdout(toJson({ sources: summaries, youtube }, true));
  else {
    for (const summary of summaries) context.stdout(renderSummary(summary));
    for (const item of youtube) context.stdout(renderYoutube(item));
  }
  throwFailures(context, failures, plan.jobs.length);
}

interface JobFailure {
  source: string;
  error: unknown;
}

/** One failure is thrown as it was, so its message and exit code are unchanged; several are listed, then summarised. */
function throwFailures(context: CommandContext, failures: JobFailure[], jobs: number): void {
  const first = failures[0];
  if (!first) return;
  if (failures.length === 1) throw first.error;
  for (const failure of failures)
    context.stderr(`rhen: ${failure.source}: ${failure.error instanceof Error ? failure.error.message : "failed"}`);
  throw new CliError(
    `${failures.length} of ${jobs} imports failed (see above). The others were imported and are listed in the output.`,
    first.error instanceof CliError ? first.error.exitCode : EXIT.unavailable
  );
}

const YOUTUBE_RUN_SOURCE = "youtube-watch-history";

type RunBody = {
  source: string;
  status: "synced" | "needs_review" | "failed";
  startedAt: string;
  finishedAt: string;
  summary: {
    file: string;
    events: number;
    skipped: number;
    rejected: number;
    truncated: number;
    warnings: string[];
    error?: string;
  };
};

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const jobFiles = (job: EventJob | YoutubeJob): string[] => (job.kind === "youtube" ? [job.file] : job.files);
const baseOf = (file: string | undefined) => (file ? basename(file) : "");

/**
 * Posts each finished job to `POST /api/activity-imports/runs`, so an import that brought in nothing is a row the
 * portal can show and not a silence. A failed post prints one warning for the whole command and never fails the import.
 */
function runPoster(context: CommandContext) {
  let warned = false;
  return {
    async post(body: RunBody): Promise<void> {
      try {
        await context.client.post("/api/activity-imports/runs", body);
      } catch (error) {
        if (warned) return;
        warned = true;
        context.stderr(
          `rhen: could not record the run in the portal (${error instanceof Error ? cut(error.message, 200) : "unknown error"}). The import itself is not affected.`
        );
      }
    }
  };
}

function eventsRun(source: string, summary: SourceSummary, startedAt: Date, finishedAt: Date): RunBody {
  const warnings: string[] = [];
  if (summary.warning) warnings.push(cut(summary.warning, 200));
  if (summary.truncated) warnings.push("The file ends in the middle of a record, so it looks cut off.");
  for (const group of summary.rejections.slice(0, 3))
    warnings.push(cut(`rejected ${group.count}: ${group.reason}`, 200));
  const status = summary.skipped > 0 || summary.rejected > 0 || warnings.length > 0 ? "needs_review" : "synced";
  return {
    source,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary: {
      file: cut(baseOf(summary.files[0]), 300),
      events: summary.added,
      skipped: summary.skipped,
      rejected: summary.rejected,
      truncated: summary.truncated ? 1 : 0,
      warnings: warnings.slice(0, 20)
    }
  };
}

function youtubeRun(
  source: string,
  job: YoutubeJob,
  result: WatchImportResult,
  startedAt: Date,
  finishedAt: Date
): RunBody {
  return {
    source,
    status: result.skipped > 0 ? "needs_review" : "synced",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary: {
      file: cut(baseOf(job.file), 300),
      events: result.added,
      skipped: result.skipped,
      rejected: 0,
      truncated: 0,
      warnings: []
    }
  };
}

function failedRun(
  source: string,
  job: EventJob | YoutubeJob,
  partial: SourceSummary | undefined,
  error: unknown,
  paths: string[],
  startedAt: Date,
  finishedAt: Date
): RunBody {
  let message = error instanceof Error ? error.message : "The import failed.";
  // The portal keeps a base name, never a directory: scrub every path this run named from the message too.
  for (const path of paths.filter((entry) => entry.length > 0).sort((a, b) => b.length - a.length))
    message = message.split(path).join(basename(path));
  return {
    source,
    status: "failed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary: {
      file: cut(baseOf(jobFiles(job)[0]), 300),
      events: partial?.added ?? 0,
      skipped: partial?.skipped ?? 0,
      rejected: partial?.rejected ?? 0,
      truncated: 0,
      warnings: [],
      error: cut(message, 500)
    }
  };
}

function newSummary(job: EventJob, dryRun: boolean): SourceSummary {
  return {
    source: job.source,
    files: job.files,
    status: dryRun ? "dry-run" : "imported",
    read: 0,
    sent: 0,
    added: 0,
    alreadyHeld: 0,
    contentDropped: 0,
    rejected: 0,
    rejections: [],
    skipped: 0,
    ignored: 0,
    skippedReasons: {},
    skippedVerbs: {},
    truncated: false,
    importId: null
  };
}

async function runEvents(
  context: CommandContext,
  plan: ImportPlan,
  job: EventJob,
  path: string,
  options: { dryRun: boolean; again: boolean },
  summary: SourceSummary
): Promise<SourceSummary> {
  let sha256 = "";
  let filename = "";
  if (!options.dryRun) {
    sha256 = await plan.sha256For(job);
    filename = (plan.archive.kind === "file" ? basename(path) : `${basename(path)} (${job.source})`).slice(
      0,
      ACTIVITY_FILENAME_MAX_CHARS
    );
    const held = await context.client.get<HeldResponse>(`/api/activity-imports?sha256=${sha256}`);
    if (held.held && !options.again) {
      summary.status = "already-held";
      summary.importId = held.importId ?? null;
      summary.added = 0;
      summary.alreadyHeld = held.eventCount ?? 0;
      return summary;
    }
  }

  const groups = new Map<string, RejectionGroup>();
  let importId: string | null = null;
  let batch: ActivityEventDraft[] = [];
  let batchBytes = 0;
  let batchStart = 0;
  let sent = 0;
  let batches = 0;
  let oversized = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const body: Record<string, unknown> = { schema: 1, events: batch };
    if (importId) body.importId = importId;
    else body.import = { sha256, filename, source: job.source };
    let response: BatchResponse;
    try {
      response = await context.client.post<BatchResponse>("/api/activity-events", body);
    } catch (error) {
      if (error instanceof CliError)
        throw new CliError(
          `${error.message} (stopped after ${sent} of this file's events were accepted; run the same command again with --yes to continue: events already held are never duplicated.)`,
          error.exitCode,
          error.details,
          error.agent
        );
      throw error;
    }
    importId = response.importId ?? importId;
    summary.added += response.added;
    summary.alreadyHeld += response.alreadyHeld;
    summary.contentDropped += response.contentDropped;
    for (const rejection of response.rejected ?? []) {
      summary.rejected += 1;
      // Reasons quote the offending value, so group by the reason with times blanked and show the first as sent.
      const groupKey = rejection.reason.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g, "<time>");
      const group = groups.get(groupKey);
      if (group) group.count += 1;
      else groups.set(groupKey, { reason: rejection.reason, count: 1, firstEvent: batchStart + rejection.index + 1 });
    }
    sent += batch.length;
    summary.sent = sent;
    batchStart += batch.length;
    batches += 1;
    if (batches % 20 === 0) context.stderr(`rhen: ${job.source}: ${sent} events sent...`);
    batch = [];
    batchBytes = 0;
  };

  try {
    for await (const event of job.events()) {
      if (options.dryRun) {
        if (Buffer.byteLength(JSON.stringify(event)) + 1 > MAX_EVENT_BYTES) oversized += 1;
        else summary.sent += 1;
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (size > MAX_EVENT_BYTES) {
        oversized += 1;
        continue;
      }
      if (batch.length >= ACTIVITY_MAX_BATCH || (batch.length > 0 && batchBytes + size > BATCH_BYTES)) await flush();
      batch.push(event);
      batchBytes += size;
    }
    if (!options.dryRun) await flush();
  } catch (error) {
    // A damaged zip entry is found only when its last bytes are read, after earlier events may have been posted.
    if (error instanceof ImportReadError && importId)
      context.stderr(
        `rhen: ${job.source}: stopped after ${sent} events were sent. They are stored under import ${importId}; the owner can undo that import by id (DELETE /api/activity-imports/${importId}), or run this command again with --yes once the export is fixed.`
      );
    throw error;
  }

  const stats = job.stats;
  summary.read = stats.read;
  summary.skipped = stats.skipped;
  summary.ignored = stats.ignored;
  summary.skippedReasons = { ...stats.reasons };
  summary.skippedVerbs = Object.fromEntries(
    Object.entries(stats.verbs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  );
  if (oversized > 0) {
    summary.skipped += oversized;
    summary.skippedReasons["event is larger than 1 MB, so it was not sent"] = oversized;
  }
  summary.truncated = stats.truncated;
  summary.importId = importId;
  summary.rejections = [...groups.values()].sort((a, b) => b.count - a.count);
  const warning = suspiciousRun(summary, stats.emitted, job);
  if (warning) summary.warning = warning;
  return summary;
}

/** A matched file that gave no events, or mostly skipped rows, must not look like a success. */
function suspiciousRun(summary: SourceSummary, emitted: number, job: EventJob): string | undefined {
  const top = Object.entries(summary.skippedReasons).sort((a, b) => b[1] - a[1])[0];
  const nothing = emitted === 0;
  const mostly = summary.read > 0 && summary.skipped * 2 > summary.read;
  if (!nothing && !mostly) return undefined;
  const file = job.files[0] ? basename(job.files[0]) : "the file";
  const what = nothing
    ? summary.read === 0
      ? `read no rows and produced no events from ${file}`
      : `read ${summary.read} rows but produced no events from ${file}`
    : `skipped ${summary.skipped} of ${summary.read} rows from ${file}`;
  return `WARNING ${summary.source}: ${what}.${top ? ` The commonest reason: "${top[0]}" (${top[1]} rows).` : ""} If you expected events, the format may not match this importer. Report it with: the source name (${summary.source}), the file name (${file}) and the skipped reasons listed here. Do not send the file's contents or any personal data.`;
}

async function runYoutube(
  context: CommandContext,
  job: YoutubeJob,
  path: string,
  dryRun: boolean
): Promise<{ file: string; result: WatchImportResult | null; dryRun: boolean }> {
  if (job.size > WATCH_IMPORT_MAX_FILE_BYTES)
    throw new CliError(
      `${job.file} is ${Math.round(job.size / 1048576)} MB; the watch-history route reads at most ${Math.round(WATCH_IMPORT_MAX_FILE_BYTES / 1048576)} MB. Export a shorter date range from takeout.google.com (YouTube, History, JSON) and import that.`,
      EXIT.usage
    );
  if (dryRun) return { file: job.file, result: null, dryRun: true };
  const bytes = await job.read();
  // Only the history entry is read; the old parser is the route's own. Base64 keeps the body under its 70 MB cap.
  const result = await context.client.post<WatchImportResult>("/api/imports/watch-history", {
    filename: basename(job.file) || basename(path),
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64")
  });
  return { file: job.file, result, dryRun: false };
}

function renderSummary(summary: SourceSummary): string {
  const lines: string[] = [];
  const files = summary.files.length === 1 ? basename(summary.files[0]!) : `${summary.files.length} files`;
  if (summary.status === "already-held") {
    lines.push(
      `${summary.source} (${files}): the portal already holds an import of this file (${summary.alreadyHeld} events, import ${summary.importId ?? "unknown"}). Nothing was sent. A previous run may have been interrupted before it finished, so this does not prove the file is complete: run the same command again with --yes to resume. Sending again is safe, because events already held are never duplicated.`
    );
    return lines.join("\n");
  }
  const head =
    summary.status === "dry-run"
      ? `${summary.source} (${files}): dry run, nothing sent. Read ${summary.read} rows; ${summary.sent} would be sent`
      : `${summary.source} (${files}): read ${summary.read} rows; sent ${summary.sent}: added ${summary.added}, already held ${summary.alreadyHeld}, rejected ${summary.rejected}`;
  lines.push(`${head}; skipped ${summary.skipped} unreadable, ignored ${summary.ignored}.`);
  if (summary.contentDropped > 0)
    lines.push(
      `  ${summary.contentDropped} events had their content dropped because this source's content gate is off. Turn it on in the portal settings first if you want the text kept.`
    );
  if (summary.truncated)
    lines.push(
      "  The file ends in the middle of a record, so it looks cut off. What was read before that is included; download the export again."
    );
  for (const [reason, count] of Object.entries(summary.skippedReasons)) lines.push(`  skipped ${count}: ${reason}`);
  if (summary.warning) lines.push(`  ${summary.warning}`);
  const verbs = Object.entries(summary.skippedVerbs);
  if (verbs.length > 0)
    lines.push(`  commonest skipped title verbs: ${verbs.map(([verb, count]) => `${verb} (${count})`).join(", ")}`);
  for (const group of summary.rejections.slice(0, REASON_GROUPS_SHOWN))
    lines.push(`  rejected ${group.count}: ${group.reason} (first at event ${group.firstEvent})`);
  if (summary.rejections.length > REASON_GROUPS_SHOWN)
    lines.push(`  ...and ${summary.rejections.length - REASON_GROUPS_SHOWN} more reasons (use --json for all).`);
  if (summary.importId)
    lines.push(
      `  import id ${summary.importId} (undo: DELETE /api/activity-imports/${summary.importId} as the owner).`
    );
  return lines.join("\n");
}

function renderYoutube(item: { file: string; result: WatchImportResult | null; dryRun: boolean }): string {
  if (item.dryRun || !item.result)
    return `youtube (${item.file}): dry run, nothing sent; the history would go to the watch-history route.`;
  const r = item.result;
  return `youtube (${item.file}): watch-history route read ${r.read}; added ${r.added}, already held ${r.alreadyHeld}, skipped ${r.skipped}${r.importId ? `; import id ${r.importId}` : ""}.`;
}
