import { handoffRequestSchema, workspaceToolCallSchema, type WorkspaceToolCallContract } from "@openrhen/contracts";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortalState } from "../client.js";
import {
  booleanOption,
  requirePositional,
  stringOption,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import type { AnyRecord } from "../entities.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { coordinatingRulesText, deliverableCommandMapText } from "../guide-content.js";
import { toJson } from "../output.js";
import { resolveReference } from "../resolve.js";
import { formatClock } from "../when.js";
import {
  DRY_RUN_NOTICE,
  newCommandId,
  readJsonFile,
  recordServerChecked,
  sendCommand,
  stampCommandId
} from "../write.js";

const SUBCOMMANDS = [
  "next",
  "handoff",
  "pick-up",
  "pack",
  "note",
  "drop-off",
  "export-sources",
  "add-to-breakdown",
  "approve",
  "extend-plan",
  "complete-steps",
  "begin-review",
  "record-review",
  "record-blocker",
  "resolve-blocker",
  "submit"
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const WORKSPACE_MOVE_SUBCOMMANDS: readonly Subcommand[] = [
  "add-to-breakdown",
  "approve",
  "extend-plan",
  "complete-steps",
  "begin-review",
  "record-review",
  "record-blocker",
  "resolve-blocker",
  "submit"
];

/** The deliverable id encoded on a `deliverable`-kind directive's forecast unit, e.g. "deliverable:abc" -> "abc". */
const FORECAST_UNIT_PREFIX = "deliverable:";

const DEFAULT_TRANSCRIPT_LIMIT = 30;

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function surfaceOf(context: CommandContext): "stdio" | "remote" {
  return context.remote === true ? "remote" : "stdio";
}

function printDryRun(context: CommandContext, path: string, payload: Record<string, unknown>): void {
  context.stdout(toJson({ dryRun: true, ...DRY_RUN_NOTICE, path, payload }, true));
}

/** The tool name a handoff/pick-up/note/drop-off row is recorded under: --tool, else OPENRHEN_TOOL_NAME, else "external tool". */
function resolveToolName(args: ParsedArgs): string {
  return stringOption(args.values, "tool") ?? process.env.OPENRHEN_TOOL_NAME ?? "external tool";
}

/** Resolves --steps (comma-separated ids or exact titles) against a deliverable's own steps, to titles — the shape the workspace-move contract wants. */
function resolveStepTitles(deliverable: AnyRecord, raw: string): string[] {
  const steps = Array.isArray(deliverable.steps) ? (deliverable.steps as AnyRecord[]) : [];
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) throw new CliError("--steps needs at least one step id or title.", EXIT.usage);
  return tokens.map((token) => {
    const match = steps.find((step) => step.id === token || step.title === token);
    if (!match) throw new CliError(`No step "${token}" on this deliverable.`, EXIT.notFound);
    return match.title as string;
  });
}

/** A link already sitting at an export path would carry the write outside `--dir`, so it is refused. */
function refuseSymlink(target: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(target).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) throw new CliError(`${target} is a symbolic link; export-sources will not write through it.`, EXIT.usage);
}

function sanitiseFilename(name: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping ASCII control characters from filenames is the intent
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  return safe.length > 200 ? safe.slice(0, 200) : safe;
}

// --- Pack rendering ------------------------------------------------------------------------------

function opt(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value.trim().length > 0 ? value : fallback;
  return String(value);
}

function listOr(values: unknown, fallback = "(none)"): string {
  const arr = Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.length > 0) : [];
  return arr.length > 0 ? arr.join(", ") : fallback;
}

interface PackRenderOptions {
  /** The surface the pack is shown on: the rules and command map name the tool's arguments on `/mcp`. */
  surface: "stdio" | "remote";
  timeZone: string;
  transcriptLimit: number;
  id: string;
}

function renderPackMarkdown(pack: AnyRecord, options: PackRenderOptions): string {
  const deliverable = isRecord(pack.deliverable) ? pack.deliverable : {};
  const criteria = Array.isArray(pack.criteria) ? (pack.criteria as AnyRecord[]) : [];
  const steps = Array.isArray(pack.steps) ? (pack.steps as AnyRecord[]) : [];
  const blockers = Array.isArray(pack.blockers) ? (pack.blockers as AnyRecord[]) : [];
  const readiness = isRecord(pack.readiness) ? pack.readiness : {};
  const session = isRecord(pack.session) ? pack.session : null;
  const sources = Array.isArray(pack.sources) ? (pack.sources as AnyRecord[]) : [];
  const transcript = Array.isArray(pack.transcript) ? (pack.transcript as AnyRecord[]) : [];
  const coordination = isRecord(pack.coordination) ? pack.coordination : {};
  const tz = options.timeZone;
  const fmt = (iso: unknown) => (typeof iso === "string" && iso ? formatClock(iso, tz) : "none");

  const lines: string[] = [];
  lines.push(`# ${opt(deliverable.title, "Deliverable")} (${opt(deliverable.id, options.id)})`);
  lines.push(
    `Project: ${opt(deliverable.projectTitle)}  ·  Phase: ${opt(deliverable.phase)}  ·  Status: ${opt(deliverable.status)}`
  );
  lines.push(
    `External deadline: ${fmt(deliverable.externalDeadlineAt)}  ·  Internal deadline: ${fmt(deliverable.internalDeadlineAt)}`
  );
  lines.push("");

  lines.push("## Coordination");
  if (coordination.handedOff) lines.push(`Handed off to ${opt(coordination.tool)} since ${fmt(coordination.since)}.`);
  else lines.push("Not currently handed off.");
  if (typeof coordination.lastDropOffSummary === "string" && coordination.lastDropOffSummary.trim())
    lines.push(`Last drop-off: ${coordination.lastDropOffSummary}`);
  lines.push("");

  lines.push("## Details");
  lines.push(opt(deliverable.details, "(no details)"));
  lines.push(
    `Uncertainty: ${opt(deliverable.uncertainty)}  Importance: ${opt(deliverable.importance)}  ` +
      `Consequence: ${opt(deliverable.consequence)}  Completion threshold: ${opt(deliverable.completionThreshold)}`
  );
  lines.push(
    `Contract v${opt(deliverable.contractVersion)} approved ${fmt(deliverable.contractApprovedAt)}  ·  ` +
      `Plan v${opt(deliverable.planVersion)} approved ${fmt(deliverable.planApprovedAt)}`
  );
  if (typeof deliverable.approvalNote === "string" && deliverable.approvalNote.trim())
    lines.push(`Approval note: ${deliverable.approvalNote}`);
  lines.push(`Depends on: ${listOr(deliverable.dependsOnDeliverableTitles)}`);
  // Edges to a project or an action: the pack names them as {kind, id, title?} where it can.
  if (Array.isArray(deliverable.prerequisites) && deliverable.prerequisites.length)
    lines.push(
      `Also waits on: ${deliverable.prerequisites
        .map((ref: { kind?: unknown; id?: unknown; title?: unknown }) => `${opt(ref.kind)} ${opt(ref.title ?? ref.id)}`)
        .join(", ")}`
    );
  lines.push("");

  lines.push("## Criteria");
  if (criteria.length === 0) lines.push("No criteria.");
  for (const criterion of criteria) {
    lines.push(`- [${criterion.required ? "required" : "optional"}] ${opt(criterion.title)} — ${opt(criterion.state)}`);
    if (typeof criterion.interpretation === "string" && criterion.interpretation.trim())
      lines.push(`  Interpretation: ${criterion.interpretation}`);
    if (criterion.sourceDocument || criterion.sourceLocation)
      lines.push(
        `  Source: ${[criterion.sourceDocument, criterion.sourceLocation].filter((value) => typeof value === "string" && value).join(" ")}`
      );
    if (typeof criterion.expectedEvidence === "string" && criterion.expectedEvidence.trim())
      lines.push(`  Expected evidence: ${criterion.expectedEvidence}`);
    if (typeof criterion.verificationMethod === "string" && criterion.verificationMethod.trim())
      lines.push(`  Verification: ${criterion.verificationMethod}`);
    if (typeof criterion.notes === "string" && criterion.notes.trim()) lines.push(`  Notes: ${criterion.notes}`);
    lines.push(`  Steps: ${listOr(criterion.stepTitles)}`);
  }
  lines.push("");

  lines.push("## Actions");
  if (steps.length === 0) lines.push("No steps.");
  for (const step of steps) {
    lines.push(`- ${opt(step.title)} [${opt(step.status)}]${step.required ? " (required)" : ""}`);
    lines.push(
      `  Minutes: expected ${opt(step.expectedMinutes)}, remaining ${opt(step.remainingMinutes)} ` +
        `(range ${opt(step.optimisticMinutes)}–${opt(step.pessimisticMinutes)})  Energy: ${opt(step.energy)}`
    );
    lines.push(step.executable ? "  Executable now." : `  Not executable: ${opt(step.readiness, "no reason given")}`);
    lines.push(`  Depends on: ${listOr(step.dependsOnStepTitles)}`);
    if (typeof step.completionCondition === "string" && step.completionCondition.trim())
      lines.push(`  Completion condition: ${step.completionCondition}`);
    if (typeof step.details === "string" && step.details.trim()) lines.push(`  Details: ${step.details}`);
    if (typeof step.completedAt === "string" && step.completedAt) lines.push(`  Completed ${fmt(step.completedAt)}.`);
    if (typeof step.recordedSeconds === "number")
      lines.push(`  Recorded time: ${Math.round(step.recordedSeconds / 60)} min`);
    if (isRecord(step.reblockOnComplete))
      lines.push(
        `  Reopens on completion: ${opt((step.reblockOnComplete as AnyRecord).category)} — ${opt((step.reblockOnComplete as AnyRecord).description)}`
      );
  }
  lines.push("");

  lines.push("## Blockers");
  if (blockers.length === 0) lines.push("No blockers.");
  for (const blocker of blockers) {
    lines.push(`- [${opt(blocker.state)}] ${opt(blocker.description)} (${opt(blocker.category)})`);
    lines.push(`  Blocks: ${listOr(blocker.stepTitles, "the whole deliverable")}`);
    if (typeof blocker.proposedResolution === "string" && blocker.proposedResolution.trim())
      lines.push(`  Proposed resolution: ${blocker.proposedResolution}`);
    if (typeof blocker.resolutionNotes === "string" && blocker.resolutionNotes.trim())
      lines.push(`  Resolution notes: ${blocker.resolutionNotes}`);
  }
  lines.push("");

  lines.push("## Sources");
  if (sources.length === 0) lines.push("No sources.");
  for (const source of sources) {
    lines.push(`- ${opt(source.title)} (${opt(source.sourceType)})`);
    const files = Array.isArray(source.files) ? (source.files as AnyRecord[]) : [];
    for (const file of files)
      lines.push(
        `  File: ${opt(file.filename)} (${opt(file.mimeType)}, ${opt(file.byteSize)} bytes) — ${opt(file.downloadPath)}`
      );
    if (typeof source.capturedText === "string" && source.capturedText.trim()) {
      lines.push(`  Captured text${source.capturedTextTruncated ? " (truncated)" : ""}:`);
      lines.push(
        source.capturedText
          .split("\n")
          .map((row: string) => `    ${row}`)
          .join("\n")
      );
    }
  }
  lines.push("");

  lines.push(`## Transcript (last ${options.transcriptLimit} rows)`);
  const shown = options.transcriptLimit > 0 ? transcript.slice(-options.transcriptLimit) : [];
  if (shown.length === 0) lines.push("(empty)");
  for (const row of shown) {
    const meta = isRecord(row.meta) ? row.meta : null;
    const tag = meta ? ` [${opt(meta.kind)} via ${opt(meta.tool)}]` : "";
    lines.push(`- ${fmt(row.createdAt)} [${opt(row.role)}]${tag}: ${opt(row.content)}`);
  }
  lines.push("");

  lines.push("## Readiness");
  lines.push(`Eligible: ${readiness.eligible ? "yes" : "no"}. ${opt(readiness.reason, "")}`.trim());
  lines.push(`Coverage failures: ${listOr(readiness.coverageFailures)}`);
  lines.push(`Executable step ids: ${listOr(readiness.executableStepIds)}`);
  lines.push("");

  lines.push("## Session");
  if (session)
    lines.push(
      `Running: step "${opt(session.stepTitle)}", status ${opt(session.status)}, planned end ${fmt(session.plannedEndAt)}, ` +
        `elapsed ${typeof session.elapsedSeconds === "number" ? Math.round(session.elapsedSeconds / 60) : "?"} min.`
    );
  else lines.push("No session running.");
  lines.push("");

  lines.push("## Rules");
  lines.push(coordinatingRulesText(options.surface));
  lines.push("");

  lines.push("## Commands");
  lines.push(deliverableCommandMapText(options.id, options.surface));

  return lines.join("\n");
}

// --- Subcommand handlers ---------------------------------------------------------------------------

async function fetchPack(context: CommandContext, id: string): Promise<AnyRecord> {
  const pack = await context.client.get<AnyRecord>(`/api/deliverables/${id}/pack`);
  // The pack's ready-made prompts tell a person to run the CLI; a remote agent already has the tool.
  if (context.remote === true) delete pack.prompts;
  return pack;
}

async function runHandoff(context: CommandContext, args: ParsedArgs, id: string, timeZone: string): Promise<void> {
  const pack = await fetchPack(context, id);
  const prompts = isRecord(pack.prompts) ? pack.prompts : {};
  const promptText =
    typeof prompts.handoff === "string" && prompts.handoff
      ? prompts.handoff
      : `Coordinate the deliverable "${opt(isRecord(pack.deliverable) ? pack.deliverable.title : undefined, "this deliverable")}" ` +
        `(id ${id}) by running "rhen deliverable pick-up ${id}".`;
  const inline = booleanOption(args.values, "inline");
  if (context.mode !== "table") {
    context.stdout(toJson(inline ? { prompt: promptText, pack } : { prompt: promptText }, true));
    return;
  }
  context.stdout(promptText);
  if (inline) {
    context.stdout("");
    context.stdout(
      renderPackMarkdown(pack, { surface: surfaceOf(context), timeZone, transcriptLimit: DEFAULT_TRANSCRIPT_LIMIT, id })
    );
  }
}

async function runPickUp(context: CommandContext, args: ParsedArgs, id: string, timeZone: string): Promise<void> {
  const tool = resolveToolName(args);
  const body = { kind: "pick_up" as const, tool };
  const parsed = handoffRequestSchema.safeParse(body);
  if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
  const path = `/api/deliverables/${id}/handoff`;
  if (booleanOption(args.values, "dry-run")) {
    printDryRun(context, path, parsed.data);
    return;
  }
  context.stderr(`rhen: picked up as "${tool}"`);
  await context.client.post(path, parsed.data);
  const pack = await fetchPack(context, id);
  if (context.mode !== "table") {
    // Over /mcp the answer is JSON, which the rendered pack's rules and command map never reach: say where they are.
    context.stdout(
      toJson(
        context.remote === true
          ? {
              ...pack,
              rules: coordinatingRulesText("remote"),
              guide: 'rhen_guide topic "coordinating" has the payload shapes and the revision loop.'
            }
          : pack,
        true
      )
    );
    return;
  }
  context.stdout(
    renderPackMarkdown(pack, { surface: surfaceOf(context), timeZone, transcriptLimit: DEFAULT_TRANSCRIPT_LIMIT, id })
  );
}

async function runPack(context: CommandContext, args: ParsedArgs, id: string, timeZone: string): Promise<void> {
  const limitRaw = stringOption(args.values, "transcript");
  const limit = limitRaw !== undefined ? Number(limitRaw) : DEFAULT_TRANSCRIPT_LIMIT;
  if (limitRaw !== undefined && (!Number.isInteger(limit) || limit < 0))
    throw new CliError("--transcript must be a non-negative whole number.", EXIT.usage);
  const pack = await fetchPack(context, id);
  if (context.mode !== "table") {
    context.stdout(toJson(pack, true));
    return;
  }
  context.stdout(renderPackMarkdown(pack, { surface: surfaceOf(context), timeZone, transcriptLimit: limit, id }));
}

function printHandoffResponse(context: CommandContext, response: unknown, fallback: string): void {
  if (context.mode !== "table") {
    context.stdout(toJson(response, true));
    return;
  }
  context.stdout(fallback);
}

async function runNote(context: CommandContext, args: ParsedArgs, id: string): Promise<void> {
  const text = stringOption(args.values, "text");
  if (!text) throw new CliError("--text is required.", EXIT.usage);
  const tool = resolveToolName(args);
  const body = { kind: "note" as const, tool, text };
  const parsed = handoffRequestSchema.safeParse(body);
  if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
  const path = `/api/deliverables/${id}/handoff`;
  if (booleanOption(args.values, "dry-run")) {
    printDryRun(context, path, parsed.data);
    return;
  }
  context.stderr("rhen: recorded a note");
  const response = await context.client.post(path, parsed.data);
  printHandoffResponse(context, response, "Note recorded.");
}

async function runDropOff(context: CommandContext, args: ParsedArgs, id: string): Promise<void> {
  const summary = stringOption(args.values, "summary") ?? "";
  const tool = resolveToolName(args);
  const body = { kind: "drop_off" as const, tool, text: summary };
  const parsed = handoffRequestSchema.safeParse(body);
  if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
  const path = `/api/deliverables/${id}/handoff`;
  if (booleanOption(args.values, "dry-run")) {
    printDryRun(context, path, parsed.data);
    return;
  }
  context.stderr("rhen: dropped off");
  const response = await context.client.post(path, parsed.data);
  printHandoffResponse(context, response, "Dropped off.");
}

async function runExportSources(context: CommandContext, args: ParsedArgs, id: string): Promise<void> {
  const dir = stringOption(args.values, "dir");
  if (!dir) throw new CliError("--dir is required.", EXIT.usage);
  if (booleanOption(args.values, "dry-run")) {
    context.stdout(
      toJson(
        {
          dryRun: true,
          path: `/api/deliverables/${id}/pack`,
          note: "export-sources performs no write; --dry-run only skips fetching and writing files."
        },
        true
      )
    );
    return;
  }
  if (!context.client.getBinary) throw new CliError("This client cannot download binary files.", EXIT.unavailable);
  const pack = await fetchPack(context, id);
  const sources = Array.isArray(pack.sources) ? (pack.sources as AnyRecord[]) : [];
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const source of sources) {
    const files = Array.isArray(source.files) ? (source.files as AnyRecord[]) : [];
    for (const file of files) {
      const downloadPath = typeof file.downloadPath === "string" ? file.downloadPath : "";
      if (!downloadPath) continue;
      const download = await context.client.getBinary(downloadPath);
      const filename = sanitiseFilename(String(file.filename ?? download.filename ?? file.id ?? "file"));
      const target = join(dir, filename);
      refuseSymlink(target);
      writeFileSync(target, Buffer.from(download.bytes));
      written.push(target);
    }
    const capturedText = typeof source.capturedText === "string" ? source.capturedText : "";
    if (capturedText.trim().length > 0) {
      const filename = sanitiseFilename(`${String(source.title ?? source.id ?? "source")}.md`);
      const target = join(dir, filename);
      refuseSymlink(target);
      writeFileSync(target, capturedText, "utf8");
      written.push(target);
    }
  }
  if (context.mode !== "table") {
    context.stdout(toJson({ files: written }, true));
    return;
  }
  context.stdout(written.length > 0 ? written.join("\n") : "No sources to export.");
}

/**
 * The deliverable a desktop agent asked "what should we work on?" should pick up: the current
 * directive's deliverable when the engine is already recommending one, otherwise the
 * highest-ranked eligible deliverable — nearest deadline first, among deliverables `in_progress`
 * whose pack reports at least one executable step. Candidates are checked in that order and the
 * first eligible one wins, so this costs one pack fetch per candidate examined, not per deliverable
 * in the household.
 */
async function runNext(context: CommandContext): Promise<void> {
  const state: PortalState = await context.client.getState();
  const timeZone = state.settings.timezone;
  const directive = state.planning?.result?.currentDirective as AnyRecord | undefined;
  const directiveTargetId = typeof directive?.targetId === "string" ? directive.targetId : undefined;
  const directiveDeliverableId =
    directive?.kind === "deliverable" && directiveTargetId?.startsWith(FORECAST_UNIT_PREFIX)
      ? directiveTargetId.slice(FORECAST_UNIT_PREFIX.length)
      : undefined;

  let deliverable = directiveDeliverableId
    ? state.deliverables.find((item) => item.id === directiveDeliverableId)
    : undefined;
  const viaCurrentDirective = Boolean(deliverable);
  let pack: AnyRecord | undefined;

  if (!deliverable) {
    const deadlineKey = (item: PortalState["deliverables"][number]) =>
      item.internalDeadlineAt ?? item.externalDeadlineAt ?? "9999";
    const candidates = state.deliverables
      .filter((item) => item.status === "in_progress")
      .sort((a, b) => deadlineKey(a).localeCompare(deadlineKey(b)) || a.title.localeCompare(b.title));
    for (const candidate of candidates) {
      const candidatePack = await fetchPack(context, candidate.id);
      const readiness = isRecord(candidatePack.readiness) ? candidatePack.readiness : {};
      if (readiness.eligible) {
        deliverable = candidate;
        pack = candidatePack;
        break;
      }
    }
  }

  if (!deliverable) {
    const reason = "No deliverable is currently eligible to work on.";
    if (context.mode !== "table") {
      context.stdout(toJson({ deliverable: null, reason }, true));
      return;
    }
    context.stdout(reason);
    return;
  }

  pack ??= await fetchPack(context, deliverable.id);
  const packDeliverable = isRecord(pack.deliverable) ? pack.deliverable : {};
  const prompts = isRecord(pack.prompts) ? pack.prompts : {};
  const handoffPrompt = context.remote !== true && typeof prompts.handoff === "string" ? prompts.handoff : null;
  const result = {
    id: deliverable.id,
    title: opt(packDeliverable.title, deliverable.title),
    phase: opt(packDeliverable.phase),
    status: opt(packDeliverable.status, deliverable.status),
    externalDeadlineAt: (packDeliverable.externalDeadlineAt as string | undefined) ?? null,
    internalDeadlineAt: (packDeliverable.internalDeadlineAt as string | undefined) ?? null,
    viaCurrentDirective,
    handoffPrompt
  };
  if (context.mode !== "table") {
    context.stdout(toJson(result, true));
    return;
  }
  const fmt = (iso: unknown) => (typeof iso === "string" && iso ? formatClock(iso, timeZone) : "none");
  context.stdout(`${result.title} (${result.id})`);
  context.stdout(
    `Phase: ${result.phase}  ·  Status: ${result.status}${viaCurrentDirective ? "  ·  the current directive" : ""}`
  );
  context.stdout(
    `External deadline: ${fmt(result.externalDeadlineAt)}  ·  Internal deadline: ${fmt(result.internalDeadlineAt)}`
  );
  if (handoffPrompt) {
    context.stdout("");
    context.stdout(handoffPrompt);
  }
}

/**
 * The JSON a move carries (add-to-breakdown, extend-plan, record-review): `--payload` (over MCP, an object argument),
 * else `--from <file.json>`. Exactly one is needed.
 */
function movePayload(args: ParsedArgs): unknown {
  const inline = stringOption(args.values, "payload");
  const fromPath = stringOption(args.values, "from");
  if (inline !== undefined && fromPath !== undefined)
    throw new CliError("Give --payload or --from, not both.", EXIT.usage);
  if (inline !== undefined) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new CliError("--payload must be valid JSON.", EXIT.usage);
    }
  }
  if (fromPath === undefined) throw new CliError("--payload '<json>' or --from <file.json> is required.", EXIT.usage);
  return readJsonFile(fromPath);
}

function buildWorkspaceCall(
  subcommand: Subcommand,
  args: ParsedArgs,
  deliverable: AnyRecord
): WorkspaceToolCallContract {
  switch (subcommand) {
    case "add-to-breakdown": {
      return { name: "add_to_breakdown", addition: movePayload(args) } as unknown as WorkspaceToolCallContract;
    }
    case "approve": {
      const note = stringOption(args.values, "note") ?? null;
      return { name: "start_carry_out", approvalNote: note };
    }
    case "extend-plan": {
      return { name: "extend_plan", addition: movePayload(args) } as unknown as WorkspaceToolCallContract;
    }
    case "complete-steps": {
      const stepsRaw = stringOption(args.values, "steps");
      if (!stepsRaw) throw new CliError("--steps is required.", EXIT.usage);
      const stepTitles = resolveStepTitles(deliverable, stepsRaw);
      const evidenceNote = stringOption(args.values, "evidence") ?? "";
      return { name: "mark_steps_complete", completion: { stepTitles, evidenceNote } };
    }
    case "begin-review":
      return { name: "begin_review" };
    case "record-review": {
      return { name: "record_review", review: movePayload(args) } as unknown as WorkspaceToolCallContract;
    }
    case "record-blocker": {
      const description = stringOption(args.values, "description");
      if (!description) throw new CliError("--description is required.", EXIT.usage);
      const category = stringOption(args.values, "category");
      if (!category) throw new CliError("--category is required.", EXIT.usage);
      const stepsRaw = stringOption(args.values, "steps");
      const stepTitles = stepsRaw !== undefined ? resolveStepTitles(deliverable, stepsRaw) : [];
      const proposedResolution = stringOption(args.values, "proposed-resolution");
      return {
        name: "record_blocker",
        report: {
          description,
          category,
          stepTitles,
          ...(proposedResolution !== undefined ? { proposedResolution } : {})
        }
      } as unknown as WorkspaceToolCallContract;
    }
    case "resolve-blocker": {
      const blockerDescription = stringOption(args.values, "blocker");
      if (!blockerDescription) throw new CliError("--blocker is required.", EXIT.usage);
      const resolutionNote = stringOption(args.values, "note") ?? "";
      const feedback = stringOption(args.values, "feedback");
      return {
        name: "resolve_blocker",
        resolution: { blockerDescription, resolutionNote, ...(feedback !== undefined ? { feedback } : {}) }
      };
    }
    case "submit": {
      const waitingFor = stringOption(args.values, "waiting-for");
      if (!waitingFor) throw new CliError("--waiting-for is required.", EXIT.usage);
      const category = stringOption(args.values, "category");
      const proposedResolution = stringOption(args.values, "proposed-resolution");
      return {
        name: "submit_for_result",
        submission: {
          waitingFor,
          ...(category !== undefined ? { category } : {}),
          ...(proposedResolution !== undefined ? { proposedResolution } : {})
        }
      } as unknown as WorkspaceToolCallContract;
    }
    default:
      throw new CliError(`"${subcommand}" is not a workspace move.`, EXIT.usage);
  }
}

async function runWorkspaceMove(
  context: CommandContext,
  args: ParsedArgs,
  subcommand: Subcommand,
  id: string,
  deliverable: AnyRecord
): Promise<void> {
  const call = buildWorkspaceCall(subcommand, args, deliverable);
  const parsed = workspaceToolCallSchema.safeParse(call);
  if (!parsed.success) throw new CliError(firstIssueMessage(parsed.error), EXIT.validation, parsed.error.issues);
  const path = `/api/deliverables/${id}/workspace`;
  const stamped = stampCommandId(context, args, { call: parsed.data, commandId: newCommandId() });
  if (booleanOption(args.values, "dry-run")) {
    printDryRun(context, path, stamped.payload);
    return;
  }
  const response = await sendCommand<{ summary: string; applied: boolean; deliverable: unknown }>(
    context.client,
    path,
    stamped.payload,
    stamped.key
  );
  const note = response.applied === false ? " (already recorded)" : "";
  context.stderr(`rhen: ${response.summary}${note}`);
  // The portal kept the deliverable's rows for an agent's move (`revertible`), so one `undo` puts the whole move back.
  recordServerChecked(context, response, { path, sent: stamped.payload, summary: `deliverable ${subcommand} ${id}` });
  if (context.mode !== "table") {
    context.stdout(toJson(response, true));
    return;
  }
  context.stdout(`${response.summary}${note}`);
}

// --- Command spec ------------------------------------------------------------------------------------

export const deliverableCommand: CommandSpec = {
  name: "deliverable",
  summary: "Coordinate a deliverable's workspace from a desktop AI app or CLI agent",
  description:
    "Hands a deliverable's workspace to an external coordinator (a desktop AI app or another CLI agent) and " +
    "back: `handoff`/`pick-up` start a session and print a context pack, `pack` re-reads it, `note`/`drop-off` " +
    "record progress and end the handoff. `add-to-breakdown`, `approve`, `extend-plan`, `complete-steps`, " +
    "`begin-review`, `record-review`, `record-blocker`, `resolve-blocker`, and `submit` are the workspace " +
    "moves the built-in deliverable chat has, sent through POST /api/deliverables/[id]/workspace with the " +
    "same version guard, blocker dedupe, and session rollover. `submit` records that the work is handed in " +
    "and waiting on someone else, moving the deliverable to awaiting_result so it stops being recommended " +
    "until `resolve-blocker` clears the wait. `next` (no id) prints the deliverable to pick up: the current " +
    "directive's deliverable if there is one, else the highest-ranked eligible deliverable. `export-sources` " +
    "downloads every retained source file and captured text to disk. Every subcommand other than `next` takes " +
    "the deliverable by id or exact title, every write prints a one-line summary, supports --dry-run, and is " +
    "validated locally against the shared workspace-move contract before it is sent. See `rhen guide " +
    "coordinating` for the rules and the revision-loop recipe.",
  positionals: [
    {
      name: "subcommand",
      required: true,
      description: `One of: ${SUBCOMMANDS.join(", ")}`,
      enum: SUBCOMMANDS
    },
    {
      name: "id",
      required: false,
      description: "The deliverable's id or exact title (required by every subcommand but `next`)"
    }
  ],
  options: {
    tool: {
      type: "string",
      placeholder: "name",
      description:
        'Tool name recorded on the handoff (handoff/pick-up/note/drop-off; default $OPENRHEN_TOOL_NAME or "external tool")'
    },
    inline: { type: "boolean", description: "Append the rendered pack to the prompt (handoff)" },
    transcript: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "Cap the transcript to the last N rows (pack; default 30)"
    },
    text: { type: "string", placeholder: "text", description: "Note text (note)" },
    summary: { type: "string", placeholder: "text", description: "What was decided, done, and left open (drop-off)" },
    dir: {
      type: "string",
      placeholder: "path",
      localPath: true,
      description: "Directory to write files and captured text into (export-sources)"
    },
    from: {
      type: "string",
      placeholder: "file.json",
      localPath: true,
      description: "Read the payload from a JSON file (add-to-breakdown/extend-plan/record-review)"
    },
    payload: {
      type: "string",
      mcp: { type: "object" },
      placeholder: "json",
      description:
        "The move's JSON (add-to-breakdown, extend-plan: the addition; record-review: the review), as one object. " +
        "Run `pick-up` first: the pack's rules and command map give each shape."
    },
    note: { type: "string", placeholder: "text", description: "A note (approve/resolve-blocker)" },
    steps: {
      type: "string",
      placeholder: "a,b",
      description: "Step ids or exact titles, comma-separated (complete-steps, required; record-blocker, optional)"
    },
    evidence: { type: "string", placeholder: "text", description: "Evidence note (complete-steps)" },
    description: { type: "string", placeholder: "text", description: "The blocker's description (record-blocker)" },
    category: {
      type: "string",
      placeholder: "category",
      description:
        "missing_information|waiting_on_someone|prerequisite|tool_or_context_unavailable|technical_problem|" +
        "energy_or_health|other (record-blocker; submit, default waiting_on_someone)"
    },
    "proposed-resolution": {
      type: "string",
      placeholder: "text",
      description: "A proposed resolution (record-blocker, submit)"
    },
    blocker: {
      type: "string",
      placeholder: "text",
      description: "The exact blocking description to resolve (resolve-blocker)"
    },
    feedback: {
      type: "string",
      placeholder: "text",
      description: "The substance of what the blocking party said; retained as a source (resolve-blocker)"
    },
    "waiting-for": {
      type: "string",
      placeholder: "text",
      description: "What is being waited on and from whom (submit)"
    },
    "dry-run": { type: "boolean", description: "Print the payload instead of sending it" }
  },
  mutates: true,
  // Every answer carries text someone else wrote: the pack and the moves echo criteria and source text, and a note or
  // drop-off answers with the coordination state (the tool and the last drop-off summary another agent wrote).
  untrustedOutput: "file",
  examples: [
    "deliverable next",
    "deliverable handoff deliverable-chapter",
    "deliverable pick-up deliverable-chapter --tool 'Claude Code'",
    "deliverable pack deliverable-chapter --transcript 10",
    'deliverable note deliverable-chapter --text "Outline approved, starting the draft"',
    'deliverable drop-off deliverable-chapter --summary "Draft written, awaiting review"',
    "deliverable export-sources deliverable-chapter --dir ./sources",
    "deliverable add-to-breakdown deliverable-chapter --from breakdown.json",
    "deliverable extend-plan deliverable-chapter --payload '{\"steps\":[...]}'",
    "deliverable approve deliverable-chapter",
    'deliverable complete-steps deliverable-chapter --steps step-outline,step-write --evidence "Both sections drafted"',
    "deliverable begin-review deliverable-chapter",
    "deliverable record-review deliverable-chapter --from review.json",
    'deliverable record-blocker deliverable-chapter --description "Missing the rubric" --category missing_information --steps step-write',
    'deliverable resolve-blocker deliverable-chapter --blocker "Missing the rubric" --note "Rubric received" --feedback "Use the 2024 rubric, section 3 only"',
    'deliverable submit deliverable-chapter --waiting-for "the client to confirm the invoice was received"'
  ],
  async run(context, args) {
    const subcommandArg = requirePositional(deliverableCommand, args, 0);
    if (!isSubcommand(subcommandArg))
      throw new CliError(
        `Unknown deliverable subcommand "${subcommandArg}". Use one of: ${SUBCOMMANDS.join(", ")}.`,
        EXIT.usage
      );
    if (subcommandArg === "next") return runNext(context);
    const idArg = requirePositional(deliverableCommand, args, 1);

    const state: PortalState = await context.client.getState();
    const deliverable = resolveReference(state, "deliverables", idArg);
    const id = deliverable.id as string;
    const timeZone = state.settings.timezone;

    switch (subcommandArg) {
      case "handoff":
        return runHandoff(context, args, id, timeZone);
      case "pick-up":
        return runPickUp(context, args, id, timeZone);
      case "pack":
        return runPack(context, args, id, timeZone);
      case "note":
        return runNote(context, args, id);
      case "drop-off":
        return runDropOff(context, args, id);
      case "export-sources":
        return runExportSources(context, args, id);
      default:
        if ((WORKSPACE_MOVE_SUBCOMMANDS as readonly string[]).includes(subcommandArg))
          return runWorkspaceMove(context, args, subcommandArg, id, deliverable);
        throw new CliError(`Unhandled subcommand "${subcommandArg}".`, EXIT.usage);
    }
  }
};
