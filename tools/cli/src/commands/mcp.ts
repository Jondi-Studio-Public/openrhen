import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { booleanOption, globalOptions, stringOption, type CommandSpec, type OptionSpec } from "../command.js";
import { parseAgentName, withoutOwnerToken } from "../agent.js";
import { CliError, EXIT } from "../errors.js";
import { buildInfo } from "../build-info.js";
import {
  AGENT_BASES,
  AGENT_CONTRACT_VERSION,
  agentErrorResult,
  agentGoldenRules,
  agentPolicySentences,
  cliCommandToMcpCall,
  committedWriteMessage,
  conflictMessage,
  doubtfulWriteMessage,
  formatAgentCall,
  mcpManifestTool,
  missingRecordMessage,
  readFailureMessage,
  saysRecordMissing,
  renderCommandsForMcp,
  selfContainedMessage,
  toAgentError,
  unknownToolMessage,
  validateToolArguments,
  type AgentCall,
  type AgentError,
  type AgentErrorCode,
  type McpToolInputSchema
} from "@openrhen/contracts";
import { describeIssues } from "../issues.js";
import { OUTSIDE_TEXT_READ_TOOLS, fenceOutsideText } from "../outside-text.js";
import { UNTRUSTED_SOURCE_LABELS, fenceUntrusted } from "../untrusted.js";

/** What a tool handler needs to run a command and capture its output. */
type Capture = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Per-request environment for the dispatched command (over --http: carries only that request's token). */
  env?: NodeJS.ProcessEnv;
  /** Always true here: the output is read by an MCP agent, so hints name tool calls (see `CommandContext.mcp`). */
  mcp?: boolean;
};
type Runner = (argv: string[], capture: Capture) => Promise<number>;

export type LineSource = Iterable<string> | AsyncIterable<string> | NodeJS.ReadableStream;

export interface ServeMcpOptions {
  input: LineSource;
  write: (line: string) => void;
  /** Defaults to the real `runCli`. Tests inject one wired to `fakeFetch` and a fixture state. */
  runner?: Runner;
  /** Serve only non-mutating tools, and refuse a mutating one called by name. See `buildLineContext`. */
  readOnly?: boolean | undefined;
  /** Forwarded as `--state-file <path>` onto every dispatched command. See `buildLineContext`. */
  stateFile?: string | undefined;
  /** Forwarded as `--agent <name>` onto every dispatched command. See `buildLineContext`. */
  agent?: string | undefined;
  /** Serve only these mutating tools (read tools are unaffected). See `buildLineContext`. */
  allowWrites?: string[] | undefined;
  /** Hide and refuse these mutating tools. See `buildLineContext`. */
  denyWrites?: string[] | undefined;
  /** The directory file-path options are confined to. See `confineLocalPaths`. */
  filesDir?: string | undefined;
}

/** MCP tool annotations (spec 2025-06-18), all derived from the command spec in `toolAnnotations`. */
interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

/**
 * Hints for a client's confirmation UI, from the registry flags rather than set per tool: a command that
 * neither `mutates` nor makes a `localWrite` is read-only; `destructive` marks the ones whose main use removes
 * or reverses. A read is idempotent; a write is not (nor is a command that says so with `idempotent: false`),
 * because without a `command-id` each call mints its own key, and a client that retries a "safe" tool after a
 * dropped answer would otherwise save it twice. A tool is open-world when it can send something outward or returns text a third party wrote.
 */
export function toolAnnotations(spec: CommandSpec): McpToolAnnotations {
  return {
    title: spec.summary,
    readOnlyHint: !spec.mutates && spec.localWrite !== true,
    destructiveHint: spec.mutates && spec.destructive === true,
    idempotentHint: !spec.mutates && spec.idempotent !== false,
    openWorldHint: spec.outward === true || spec.untrustedOutput !== undefined
  };
}

/** A JSON-RPC error with a specific code, as opposed to an unexpected throw (which becomes -32603). */
class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReadableStream(input: LineSource): input is NodeJS.ReadableStream {
  return typeof (input as NodeJS.ReadableStream).pipe === "function";
}

/**
 * Yields complete lines. An `Iterable`/`AsyncIterable<string>` (tests: an array or async generator)
 * is already one message per item; a real `NodeJS.ReadableStream` (stdin) delivers arbitrary chunks,
 * so those are buffered and split on "\n", tolerating a trailing "\r".
 */
async function* toLines(input: LineSource): AsyncGenerator<string> {
  if (!isReadableStream(input)) {
    yield* input;
    return;
  }
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}

/**
 * The `initialize` response's `instructions` string: a short "how to use this server" pointer, per
 * the MCP spec. Names the actual script the running process was launched with (`process.argv[1]`,
 * the dist file in real use) rather than a hard-coded path, so it stays correct wherever the CLI is
 * installed.
 */
function serverInstructions(): string {
  const scriptPath = process.argv[1] ?? "tools/cli/dist/rhen.mjs";
  // Run from source (`pnpm cli mcp`), the entry is TypeScript and plain node cannot load it.
  const launcher = /\.[cm]?tsx?$/.test(scriptPath) ? "node --import tsx" : "node";
  return (
    "OpenRhen is the household planning system. Start with rhen_status for the present moment and " +
    "rhen_guide (topics: vocabulary, workflows, writing-data, reading-data, recurrence, limits, coordinating) " +
    "for vocabulary, recipes and what you may change; rhen_skill prints a SKILL.md an agent can save; " +
    'rhen_help {"command": "<name>"} gives one command\'s options (rhen_help {} returns every command, about 256 KB); rhen_schema <name> prints a payload or entity schema ' +
    "before your first write of that type. Every write tool takes a dry-run argument that previews the change " +
    "without sending it (bulk and recurrence show the records they would touch). " +
    agentGoldenRules("the owner") +
    " " +
    agentPolicySentences("the person", "brief").join(" ") +
    " Capture a passing thought with rhen_capture. Call rhen_version to confirm which build is serving " +
    "you. rhen_changes shows what changed and who changed it (start with count or a short since). Outside " +
    `MCP the same CLI runs as \`${launcher} ${scriptPath} <command>\`; no PATH entry is needed.`
  );
}

export function toolName(spec: CommandSpec): string {
  return `rhen_${spec.name.replace(/-/g, "_")}`;
}

/** CLI flags named in prose are argument names to an MCP agent: `--by` is `by`. */
const argumentWording = (text: string): string => text.replace(/(?<![\w-])--([a-z][a-z-]*)/g, "$1");

/**
 * The warning a write tool carries, kept at the end so the first sentence says what the tool is for (a client that
 * searches tools by their description reads that first). Still spelled out in every write tool's description.
 */
export const WRITES_DATA_NOTE = " WRITES DATA.";
export const writesDataNote = (mutates: boolean): string => (mutates ? WRITES_DATA_NOTE : "");

/** `withExamples: false` leaves out the shell examples, for the remote manifest, whose clients have no `rhen` command. */
export function toolDescription(spec: CommandSpec, withExamples = true, withWriteNote = true): string {
  // Each example is a shell line; an MCP agent reads it as the tool call it stands for.
  const examples = withExamples
    ? spec.examples.slice(0, 2).flatMap((example) => {
        const call = cliCommandToMcpCall(`rhen ${example}`);
        return call === null ? [] : [formatAgentCall(call)];
      })
    : [];
  const examplesText = examples.length > 0 ? ` Examples: ${examples.join("; ")}` : "";
  // MCP arguments are JSON fields named without dashes (`fields`, not `--fields`), so the flags the CLI text
  // names become the argument names. The remote manifest (withExamples false) has its own text and keeps its own words.
  const description = withExamples ? argumentWording(spec.description) : spec.description;
  return `${description}${examplesText}${withWriteNote ? writesDataNote(spec.mutates === true) : ""}`;
}

export function toolInputSchema(spec: CommandSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const positional of spec.positionals) {
    properties[positional.name] = {
      type: "string",
      description: argumentWording(positional.description),
      ...(positional.enum ? { enum: [...positional.enum] } : {})
    };
    if (positional.required || positional.mcpRequired) required.push(positional.name);
  }
  for (const [name, option] of Object.entries(spec.options)) properties[name] = optionProperty(option);
  // Not one of the command's own options: every mutating tool takes the global idempotency key, so an
  // agent that timed out can repeat the call and have the portal apply it at most once.
  if (spec.mutates && !("command-id" in properties))
    properties["command-id"] = { type: "string", description: globalOptions["command-id"]!.description };
  // Likewise the claim a write makes about itself; `propose` has its own basis and evidence.
  if (spec.mutates && !("basis" in properties))
    properties["basis"] = { type: "string", enum: [...AGENT_BASES], description: globalOptions["basis"]!.description };
  if (spec.mutates && !("evidence" in properties))
    properties["evidence"] = { type: "string", maxLength: 300, description: globalOptions["evidence"]!.description };
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {})
  };
}

/** One option's MCP property: its real JSON type when it declares one, else text, a flag or a list of text. */
function optionProperty(option: OptionSpec): Record<string, unknown> {
  const description = argumentWording(option.description);
  if (option.multiple) return { type: "array", items: { type: "string" }, description };
  const typed = option.mcp;
  if (typed?.type === "array") return { type: "array", items: { type: "object" }, description };
  if (typed) return { ...typed, description };
  return { type: option.type, description };
}

/** An argument as argv text: a number as written, an object or list as JSON. */
function argText(option: OptionSpec, value: unknown): string {
  return (option.mcp?.type === "object" || option.mcp?.type === "array") && typeof value !== "string"
    ? JSON.stringify(value)
    : String(value);
}

function buildTool(spec: CommandSpec): McpTool {
  return {
    name: toolName(spec),
    description: toolDescription(spec),
    inputSchema: toolInputSchema(spec),
    annotations: { ...toolAnnotations(spec), title: argumentWording(spec.summary) }
  };
}

/**
 * argv for one tool call: the command, its options, then `--json`. Positionals come back separately so
 * the caller can append them after the server's own flags and a `--`: a value from the model is then
 * always data, never an option, so `--url=…` or a bare `--` cannot redirect the call or drop the
 * server's `--state-file`, `--read-only` or `--agent`. Option values use the `--name=value` form for
 * the same reason.
 */
function buildArgv(spec: CommandSpec, args: Record<string, unknown>): { argv: string[]; positionals: string[] } {
  const argv: string[] = [spec.name];
  const positionals: string[] = [];
  for (const positional of spec.positionals) {
    const value = args[positional.name];
    if (value !== undefined) positionals.push(String(value));
  }
  for (const [name, option] of Object.entries(spec.options)) {
    const value = args[name];
    if (value === undefined) continue;
    if (option.multiple) {
      for (const item of Array.isArray(value) ? value : [value]) argv.push(`--${name}=${String(item)}`);
    } else if (option.type === "boolean") {
      if (value) argv.push(`--${name}`);
    } else {
      argv.push(`--${name}=${argText(option, value)}`);
    }
  }
  const commandId = spec.mutates ? args["command-id"] : undefined;
  if (commandId !== undefined) argv.push(`--command-id=${String(commandId)}`);
  for (const claim of ["basis", "evidence"]) {
    const value = spec.mutates && !(claim in spec.options) ? args[claim] : undefined;
    if (value !== undefined) argv.push(`--${claim}=${String(value)}`);
  }
  argv.push("--json");
  return { argv, positionals };
}

/**
 * A model reading untrusted text must not be able to read or write any file this process can reach
 * (a credentials file returned through `--dry-run`, say). Each `localPath` option is resolved inside
 * `filesDir`, following symlinks, and replaced with that absolute path; outside it, or with no
 * `filesDir`, the call is refused. Callers without file access use the inline options instead.
 */
function confineLocalPaths(spec: CommandSpec, args: Record<string, unknown>, filesDir: string | undefined): void {
  for (const [name, option] of Object.entries(spec.options)) {
    if (!option.localPath || args[name] === undefined) continue;
    if (filesDir === undefined)
      throw new McpProtocolError(
        -32602,
        `--${name} names a local file, which this server does not allow. Pass the content inline instead ` +
          "(for example --set or --targets-json), or set OPENRHEN_MCP_FILES_DIR on the server to a directory it may use."
      );
    if (!existsSync(filesDir))
      throw new McpProtocolError(-32602, `OPENRHEN_MCP_FILES_DIR (${filesDir}) does not exist on this server.`);
    const root = realpathSync(filesDir);
    const target = resolve(root, String(args[name]));
    if (!isInside(root, realExisting(target)))
      throw new McpProtocolError(-32602, `--${name} must name a path inside OPENRHEN_MCP_FILES_DIR (${root}).`);
    args[name] = target;
  }
}

/**
 * The real path of `path`, or of its nearest existing ancestor joined back to the rest (for a file not
 * yet written). A symlink counts as existing even when its target is missing, and is followed, so a
 * dangling link cannot pass as a new file inside the root and later be written through.
 */
function realExisting(path: string, hops = 0): string {
  if (hops > 40) throw new McpProtocolError(-32602, "A file-path option points at a symlink loop.");
  let existing = path;
  while (!entryExists(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (lstatSync(existing).isSymbolicLink() && !existsSync(existing)) {
    const target = resolve(dirname(existing), readlinkSync(existing));
    return resolve(realExisting(target, hops + 1), relative(existing, path));
  }
  return resolve(realpathSync(existing), relative(existing, path));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Where to find a generated `--http` token. On a terminal it is printed; anywhere else (a service log,
 * a supervisor capturing stderr) it goes to a file under the user's home and the log gets the path.
 * The 0600 mode protects it on POSIX only: Windows ignores mode bits, so there the file is protected by
 * the user profile directory's own permissions.
 */
export function generatedTokenNotice(
  token: string,
  port: number,
  where: { home: string; terminal: boolean } = { home: homedir(), terminal: process.stderr.isTTY === true }
): string {
  const lead = "rhen: no OPENRHEN_MCP_TOKEN was set, so a token was generated for this process only";
  if (where.terminal) return `${lead}: ${token}`;
  // One file per port, so two servers on different ports never overwrite each other's token.
  const path = join(where.home, ".openrhen", `mcp-http-token-${port}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return `${lead}; it is in ${path}.`;
}

/** Default cap injected onto an MCP `rhen_list` call that didn't specify its own `--limit`. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * MCP tool results are one blob returned to the calling model, with no pagination of their own, so an
 * unbounded `rhen_list` can dwarf the client's context. When the caller didn't ask for a
 * `--limit` (and isn't using `--count`, which is already a summary), cap it here. Returns the limit
 * that was injected, or undefined when the caller's own arguments were left alone.
 */
function applyDefaultListLimit(spec: CommandSpec, args: Record<string, unknown>): number | undefined {
  if (spec.name !== "list") return undefined;
  if (args.limit !== undefined || args.count) return undefined;
  args.limit = String(DEFAULT_LIST_LIMIT);
  return DEFAULT_LIST_LIMIT;
}

/** The row count of a `--json` list result, or undefined when `text` isn't a JSON array (an error, a non-list tool). */
function jsonRowCount(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

export type ToolContent = { type: "text"; text: string; _meta?: { untrusted: true } };

/** Whether this call returns text someone else wrote, so its result goes inside the untrusted fence. */
function untrustedSource(spec: CommandSpec, args: Record<string, unknown>): string | undefined {
  if (spec.untrustedOutput === undefined) return undefined;
  if (spec.untrustedActions !== undefined) {
    const first = spec.positionals[0];
    const action = first === undefined ? undefined : args[first.name];
    if (typeof action !== "string" || !spec.untrustedActions.includes(action)) return undefined;
  }
  return UNTRUSTED_SOURCE_LABELS[spec.untrustedOutput];
}

/** A tool call this server refuses before running anything: a normal error result, not a protocol error. */
const refusal = (code: AgentErrorCode, message: string): ToolCallResult =>
  agentErrorResult({ code, message, retryable: false });

type ToolCallResult = {
  content: ToolContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

async function handleToolsCall(params: unknown, ctx: LineContext): Promise<ToolCallResult> {
  const record = isRecord(params) ? params : {};
  const name = record.name;
  const spec = typeof name === "string" ? ctx.toolByName.get(name) : undefined;
  if (!spec) throw new McpProtocolError(-32602, unknownToolMessage(name, [...ctx.toolByName.keys()]));
  // The tool table (tools/list) already hides a mutating tool in read-only mode, but a client that
  // calls one by name anyway — not just an unrecognised name — must be told why, not just refused.
  if (ctx.readOnly && spec.mutates)
    return refusal(
      "scope",
      `"${name}" changes portal state, and this server is read-only, so nothing was changed. Use a read tool ` +
        "(rhen_status, rhen_list, rhen_show) instead, or tell the person: " +
        '"Please restart the OpenRhen MCP server without read-only mode so the agent can write."'
    );
  if (!writeAllowed(spec, ctx.allowWrites, ctx.denyWrites)) {
    const allowed = [...ctx.toolByName.entries()]
      .filter(([, other]) => other.mutates && writeAllowed(other, ctx.allowWrites, ctx.denyWrites))
      .map(([toolId]) => toolId);
    return refusal(
      "scope",
      `"${name}" changes portal state, and this server's write scope does not include it, so nothing was changed. ` +
        (allowed.length > 0
          ? `The write tools you may call here: ${allowed.join(", ")}. `
          : "This server allows no write tools. ") +
        'Or tell the person: "Please add this tool to the server\'s allowed writes."'
    );
  }

  // The same check /mcp runs: an unknown argument (a misspelt dry-run would otherwise be dropped and the write
  // sent for real), a wrong type or a missing required one is refused, and "false" is false, not a set flag.
  // Refused as a tool result an agent can read (code validation), not a JSON-RPC error.
  const checked = validateToolArguments(
    toolInputSchema(spec) as unknown as McpToolInputSchema,
    record.arguments,
    toolName(spec)
  );
  if (!checked.ok) return refusal("validation", checked.error);
  const rawArgs = checked.args;
  try {
    confineLocalPaths(spec, rawArgs, ctx.filesDir);
  } catch (error) {
    if (error instanceof McpProtocolError) return refusal("validation", error.message);
    throw error;
  }
  // Forwarded onto the dispatched command line rather than the outer process's own argv, since each
  // call runs a fresh `runCli` built only from the tool's own arguments (see `buildArgv`). `--state-file`
  // alone would already imply read-only on the far side, but `--read-only` is added too so a plain
  // `--read-only` server (no snapshot) still gets the client-level second guard on every dispatch.
  const serverFlags: string[] = [];
  if (ctx.stateFile !== undefined) serverFlags.push("--state-file", ctx.stateFile);
  if (ctx.readOnly) serverFlags.push("--read-only");
  // `changes` has its own --agent (a filter on who made the change); a later --agent would override it,
  // so a call that sets the filter goes without the caller's own name rather than lose its filter.
  if (ctx.agent !== undefined && !(spec.name === "changes" && rawArgs.agent !== undefined))
    serverFlags.push("--agent", ctx.agent);
  const { argv, injectedLimit } = toolInvocation(spec, rawArgs, serverFlags);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await ctx.runner(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    mcp: true,
    ...(ctx.env === undefined ? {} : { env: ctx.env })
  });
  return toolResult(spec, rawArgs, { exitCode, stdout: stdoutLines, stderr: stderrLines }, injectedLimit);
}

/**
 * The command line for one tool call, shared by the stdio and HTTP servers and the portal's in-process runner so
 * they cannot drift: the command, its options (`--name=value`), `serverFlags`, `--json`, then every positional
 * after a `--`. A value the model supplied is therefore always data, never an option. `rawArgs` has already been
 * checked against the tool's schema (or confined by `confineLocalPaths`); it is not changed here. An unbounded
 * `list` gets the default row cap, reported as `injectedLimit`.
 */
export function toolInvocation(
  spec: CommandSpec,
  rawArgs: Record<string, unknown>,
  serverFlags: readonly string[] = []
): { argv: string[]; injectedLimit: number | undefined } {
  const args = { ...rawArgs };
  const injectedLimit = applyDefaultListLimit(spec, args);
  const { argv, positionals } = buildArgv(spec, args);
  argv.push(...serverFlags);
  if (positionals.length > 0) argv.push("--", ...positionals);
  return { argv, injectedLimit };
}

/**
 * What a finished tool call returns: stdout as text (stderr when it failed with no stdout), fenced when the call
 * carries text someone else wrote, the row-cap note after a capped `list`, and the CLI's own notes after a success.
 */
export function toolResult(
  spec: CommandSpec,
  rawArgs: Record<string, unknown>,
  run: { exitCode: number; stdout: readonly string[]; stderr: readonly string[] },
  injectedLimit: number | undefined
): { content: ToolContent[]; isError: boolean; structuredContent?: Record<string, unknown> } {
  const { exitCode } = run;
  let text = run.stdout.join("\n");
  if (exitCode !== 0 && text === "") text = run.stderr.join("\n");
  if (exitCode === 0) text = renderFiledProposal(text);
  // A failure message and the CLI's progress notes can echo the text that made the tool untrusted (an email
  // subject in "Stopped at ..."), so stderr goes inside the fence too, not only stdout.
  const source = text !== "" ? untrustedSource(spec, rawArgs) : undefined;
  // The general read tools are not wholly outside text, so their result is fenced field by field instead.
  const perField =
    source === undefined && exitCode === 0 && OUTSIDE_TEXT_READ_TOOLS.has(spec.name)
      ? fenceOutsideText(text)
      : undefined;
  const content: ToolContent[] =
    source !== undefined
      ? [{ type: "text", text: fenceUntrusted(source, text), _meta: { untrusted: true } }]
      : perField?.fenced
        ? [{ type: "text", text: perField.text, _meta: { untrusted: true } }]
        : [{ type: "text", text: perField?.text ?? text }];
  if (injectedLimit !== undefined && exitCode === 0 && jsonRowCount(text) === injectedLimit)
    content.push({
      type: "text",
      text:
        `Result capped at ${injectedLimit} rows (the MCP default; no --limit was given). There may be more. ` +
        `Use --offset ${injectedLimit} to continue, --fields to shrink each row, or --count (optionally --by ` +
        "a field) to summarise instead of listing."
    });
  const notes = run.stderr.filter((line) => line.trim() !== "").map(renderCommandsForMcp);
  if (exitCode === 0 && notes.length) {
    const noteText = `Notes from the CLI:\n${notes.join("\n")}`;
    const noteSource = untrustedSource(spec, rawArgs);
    content.push(
      noteSource === undefined
        ? { type: "text", text: noteText }
        : { type: "text", text: fenceUntrusted(noteSource, noteText), _meta: { untrusted: true } }
    );
  }
  // `rhen_reenter` answers with data either way; a failure adds the error beside it.
  const reentry = spec.name === "reenter" ? reentryStructured(run) : undefined;
  if (exitCode === 0) return { content, isError: false, ...(reentry ? { structuredContent: reentry } : {}) };
  const error = failureAgentError(spec, rawArgs, text, exitCode);
  return {
    content: withAgentMessage(content, source, text, error),
    isError: true,
    structuredContent: { ...reentry, error }
  };
}

/** The arguments the agent can really pass: the published manifest's when the tool is in it (the remote contract), else the command's own. */
function toolProperties(spec: CommandSpec): Record<string, unknown> {
  const published = mcpManifestTool(toolName(spec));
  if (published !== undefined) return published.inputSchema.properties;
  return (toolInputSchema(spec) as { properties?: Record<string, unknown> }).properties ?? {};
}

/** A write filed as a proposal prints JSON whose reasons name CLI commands; an MCP agent gets the tool calls instead. */
function renderFiledProposal(text: string): string {
  if (!text.includes('"filedAsProposal"')) return text;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.filedAsProposal !== true) return text;
    const render = (field: unknown) => (typeof field === "string" ? renderCommandsForMcp(field) : field);
    return JSON.stringify(
      {
        ...value,
        message: render(value.message),
        filedBecause: render(value.filedBecause),
        agentNote: render(value.agentNote)
      },
      null,
      2
    );
  } catch {
    return text;
  }
}

/**
 * The failure text an agent reads: the CLI's `--json` error document with `error` replaced by the agent-facing
 * message (the same one `structuredContent.error` carries) and the CLI-only fields dropped, so the two never
 * disagree and neither names a flag the agent cannot pass. Text that is not such a document is left as it was.
 */
function withAgentMessage(
  content: ToolContent[],
  source: string | undefined,
  text: string,
  error: AgentError
): ToolContent[] {
  let document: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.error !== "string") return content;
    document = value;
  } catch {
    return content;
  }
  const { plainMessage: _plain, retry: _retry, suggestedPath: _path, ...rest } = document;
  const rewritten = JSON.stringify(
    {
      ...rest,
      error: error.message,
      ...(error.nextCall === undefined ? {} : { nextCall: error.nextCall }),
      ...(error.validValues === undefined ? {} : { validValues: error.validValues }),
      ...(error.tellThePerson === undefined ? {} : { tellThePerson: error.tellThePerson })
    },
    null,
    2
  );
  return [
    source === undefined
      ? { type: "text", text: rewritten }
      : { type: "text", text: fenceUntrusted(source, rewritten), _meta: { untrusted: true } },
    ...content.slice(1)
  ];
}

const isAgentCallShape = (value: unknown): value is AgentCall =>
  isRecord(value) && typeof value.tool === "string" && isRecord(value.arguments);

/**
 * The `AgentError` for a failed call: the CLI's `--json` error (`{error, exitCode, details, code?, suggestedPath?,
 * currentVersion?, commandId?}`) when stdout is one, else the raw text with the code its exit code names. A repeat
 * is safe for a read, and for a write only with the command id the CLI reports: the key its writes really carried
 * (an id given to a command that keys nothing would not deduplicate). The message is fenced like `content` when the
 * call carries someone else's text, since a failure can echo it.
 */
function failureAgentError(
  spec: CommandSpec,
  rawArgs: Record<string, unknown>,
  text: string,
  exitCode: number
): AgentError {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.error === "string") parsed = value;
  } catch {
    // Not a CLI error document: the text itself is the message.
  }
  const tool = toolName(spec);
  const commandId = spec.mutates && typeof parsed.commandId === "string" ? parsed.commandId : undefined;
  const unavailable = exitCode === 5;
  // A keyed write the portal could not confirm: the portal's own words, then this surface's instruction (the CLI's
  // own tail names a flag the agent cannot pass).
  const plain = typeof parsed.plainMessage === "string" ? parsed.plainMessage : undefined;
  const raw =
    plain !== undefined && commandId !== undefined ? plain : typeof parsed.error === "string" ? parsed.error : text;
  const source = untrustedSource(spec, rawArgs);
  const said = raw === "" ? `The command failed (exit code ${exitCode}).` : raw;
  const fenced = source === undefined || raw === "" ? said : fenceUntrusted(source, said);
  let message = fenced;
  const versionConflict =
    exitCode === EXIT.conflict && spec.mutates && !unavailable && typeof parsed.currentVersion === "number";
  // A version conflict is answered by the re-read-and-repeat text, never by a named call.
  const portalCall = !versionConflict && isAgentCallShape(parsed.nextCall) ? parsed.nextCall : undefined;
  const takesId = Object.hasOwn(toolProperties(spec), "command-id");
  if (unavailable && commandId !== undefined)
    message =
      parsed.retry === "committed"
        ? committedWriteMessage(fenced, commandId, tool, takesId)
        : doubtfulWriteMessage(fenced, commandId, tool, takesId);
  else if (unavailable && spec.mutates)
    message = `${fenced} The portal could not say whether this change was saved. Read the record you changed first, and repeat only if it is not there; ask the person if you cannot tell.`;
  else if (unavailable) message = readFailureMessage(fenced, tool);
  else if (versionConflict)
    // Only a true version conflict: a "wrong state" 409 carries no version and re-reading would not cure it.
    message = conflictMessage(fenced, tool, parsed.currentVersion as number, {
      expectedVersion: Object.hasOwn(toolProperties(spec), "expected-version"),
      commandId: Object.hasOwn(toolProperties(spec), "command-id")
    });
  // The portal named the exact call that resolves this refusal (list the ids, read the open session): say it in the
  // text too, since a client may show only the message. Otherwise the generic "find the id" tail for a gone record.
  else if (portalCall !== undefined && exitCode !== 6)
    message = `${fenced} Nothing was changed. Next call: ${formatAgentCall(portalCall)}${
      portalCall.note ? ` (${portalCall.note})` : ""
    }.`;
  else if ((exitCode === EXIT.conflict || exitCode === EXIT.notFound) && saysRecordMissing(fenced))
    message = missingRecordMessage(fenced);
  // The portal names CLI commands; this surface has tools, not a shell.
  const suggested = typeof parsed.suggestedPath === "string" ? parsed.suggestedPath : undefined;
  const shell = suggested !== undefined && suggested.startsWith("rhen ");
  const nextCall = shell ? (cliCommandToMcpCall(suggested) ?? undefined) : undefined;
  const problems = describeIssues(parsed.details);
  if (problems !== null && !problems.every((line) => message.includes(line)))
    message = `${message} Problems: ${problems.join("; ")}.`;
  message = selfContainedMessage(renderCommandsForMcp(message), parsed.details);
  return toAgentError({
    message,
    exitCode,
    code: parsed.code,
    suggestedPath: shell ? undefined : suggested,
    currentVersion: parsed.currentVersion,
    commandId,
    nextCall:
      exitCode === 6
        ? { tool: "rhen_reenter", arguments: {} }
        : !unavailable && portalCall !== undefined
          ? portalCall
          : nextCall,
    validValues: parsed.validValues,
    tellThePerson:
      shell && nextCall === undefined
        ? "The step the portal named is not available as a tool; ask the person to do it, or to change the token."
        : undefined,
    safeToRepeat: !spec.mutates
  });
}

/**
 * `rhen_reenter` is the one call a lapsed agent may make, so its answer is data, not just text: the read
 * (pulse with tier and gap, review items, place and context ids) and the refusal of an incomplete answer (the
 * same, plus `missing`). The CLI's `--json` output carries both; a refusal puts them under `details`.
 */
function reentryStructured(run: {
  stdout: readonly string[];
  stderr: readonly string[];
}): Record<string, unknown> | undefined {
  for (const text of [run.stdout.join("\n"), run.stderr.join("\n")]) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const details = record.details;
      return typeof details === "object" && details !== null && !Array.isArray(details)
        ? { error: record.error, ...(details as Record<string, unknown>) }
        : record;
    } catch {
      // Not JSON (a usage error): no structured content.
    }
  }
  return undefined;
}

/** Whether a tool may be served under the `--allow-writes` / `--deny-writes` scope; read tools always may. */
function writeAllowed(
  spec: CommandSpec,
  allow: ReadonlySet<string> | undefined,
  deny: ReadonlySet<string> | undefined
): boolean {
  if (!spec.mutates) return true;
  // The one call a lapsed agent may make: a write scope must never lock it out.
  if (spec.name === "reenter") return true;
  if (allow !== undefined && !allow.has(spec.name)) return false;
  return !deny?.has(spec.name);
}

/**
 * Turns a `--allow-writes` / `--deny-writes` list into command names, accepting `capture`,
 * `rhen_capture` or `check_in` for `check-in`. A name that is not a mutating command is a usage
 * error, so a typo cannot silently leave a tool open (or closed).
 */
export async function parseWriteScope(raw: string | undefined, flag: string): Promise<string[] | undefined> {
  if (raw === undefined) return undefined;
  const { commands } = await import("../registry.js");
  const mutating = commands
    .filter((spec) => spec.mutates && spec.name !== "mcp" && !spec.ownerOnly)
    .map((spec) => spec.name);
  // The prefix comes from `toolName`, so the accepted spelling is always the one the tools are served under.
  const prefix = toolName({ name: "" } as CommandSpec);
  const names = raw
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      return (trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed).replace(/_/g, "-");
    })
    .filter((entry) => entry !== "");
  const unknown = names.filter((name) => !mutating.includes(name));
  if (unknown.length > 0)
    throw new CliError(
      `${flag}: unknown write tool ${unknown.join(", ")}. Write tools: ${mutating.join(", ")}.`,
      EXIT.usage
    );
  return names;
}

export interface LineContext {
  tools: McpTool[];
  toolByName: ReadonlyMap<string, CommandSpec>;
  runner: Runner;
  serverVersion: string;
  /** True for `rhen mcp --read-only` (or `--state-file`, which implies it). */
  readOnly: boolean;
  /** Set for `rhen mcp --state-file <path>`; forwarded onto every dispatched command. */
  stateFile: string | undefined;
  /** Set for `rhen mcp --agent <name>` (or per request over --http); forwarded onto every dispatched command. */
  agent?: string | undefined;
  /** Environment the dispatched commands run with; set per request over --http, otherwise the runner's own. */
  env?: NodeJS.ProcessEnv | undefined;
  /** `--allow-writes`: the only mutating tools served; undefined means no allowlist. */
  allowWrites: ReadonlySet<string> | undefined;
  /** `--deny-writes`: mutating tools hidden and refused. */
  denyWrites: ReadonlySet<string> | undefined;
  /** `OPENRHEN_MCP_FILES_DIR`: the only directory a tool's file-path option may name; none when unset. */
  filesDir?: string | undefined;
}

export interface BuildLineContextOptions {
  /** Defaults to the real `runCli`. Tests inject one wired to `fakeFetch` and a fixture state. */
  runner?: Runner | undefined;
  /** Serve only non-mutating tools, and refuse a mutating one called by name even so. */
  readOnly?: boolean | undefined;
  /** Forwarded as `--state-file <path>` onto every dispatched command; implies `readOnly`. */
  stateFile?: string | undefined;
  /** Forwarded as `--agent <name>` onto every dispatched command. */
  agent?: string | undefined;
  /** Command names (see `parseWriteScope`): serve only these mutating tools. Read tools are unaffected. */
  allowWrites?: string[] | undefined;
  /** Command names: hide these mutating tools and refuse them if called by name. */
  denyWrites?: string[] | undefined;
  /** The directory file-path options are confined to; defaults to `OPENRHEN_MCP_FILES_DIR`. */
  filesDir?: string | undefined;
}

/**
 * Builds the shared tool table and dispatcher once — the registry's commands turned into MCP tools,
 * ready to serve `tools/list` and `tools/call` — so stdio (`serveMcp`) and the HTTP transport
 * (`mcp-http.ts`) run the exact same mapping instead of two implementations that could drift apart.
 *
 * Accepts either a bare runner function (the historical shape) or an options object naming
 * `readOnly`/`stateFile` too — `rhen mcp --read-only`'s two flags, which govern the whole
 * session rather than any one tool call, so they live here rather than in a tool's own input schema.
 */
export async function buildLineContext(runnerOrOptions?: Runner | BuildLineContextOptions): Promise<LineContext> {
  const options: BuildLineContextOptions =
    typeof runnerOrOptions === "function" ? { runner: runnerOrOptions } : (runnerOrOptions ?? {});
  const [{ commands }, { runCli, CLI_VERSION }] = await Promise.all([import("../registry.js"), import("../cli.js")]);
  const readOnly = options.readOnly === true || options.stateFile !== undefined;
  const toolSpecs = commands.filter((spec) => spec.name !== "mcp" && !spec.ownerOnly);
  // `tools/list` hides a mutating tool entirely in read-only mode; `toolByName` keeps every tool so a
  // client that calls a hidden one by name gets `handleToolsCall`'s specific refusal, not "Unknown tool".
  const allowWrites = options.allowWrites ? new Set(options.allowWrites) : undefined;
  const denyWrites = options.denyWrites ? new Set(options.denyWrites) : undefined;
  const tools = toolSpecs
    .filter((spec) => (!readOnly || !spec.mutates) && writeAllowed(spec, allowWrites, denyWrites))
    .map(buildTool);
  const toolByName = new Map(toolSpecs.map((spec) => [toolName(spec), spec]));
  return {
    tools,
    toolByName,
    runner: options.runner ?? ((argv, capture) => runCli(argv, capture)),
    // `0.1.0+c9d81b2` (semver build metadata) so a host can see which build it is talking to; plain when unbuilt.
    serverVersion: buildInfo.commit === "dev" ? CLI_VERSION : `${CLI_VERSION}+${buildInfo.commit}`,
    readOnly,
    stateFile: options.stateFile,
    agent: options.agent,
    allowWrites,
    denyWrites,
    filesDir: options.filesDir ?? (process.env.OPENRHEN_MCP_FILES_DIR || undefined)
  };
}

/** Handles one JSON-RPC line; returns the response line to write, or null when nothing should be sent. */
export async function handleLine(line: string, ctx: LineContext): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (!isRecord(parsed))
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  const hasId = Object.hasOwn(parsed, "id");
  const id = hasId ? (parsed.id ?? null) : null;
  const method = parsed.method;

  const respond = (result: unknown): string | null => (hasId ? JSON.stringify({ jsonrpc: "2.0", id, result }) : null);
  const respondError = (code: number, message: string): string | null =>
    hasId ? JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) : null;

  try {
    switch (method) {
      case "initialize": {
        const params = isRecord(parsed.params) ? parsed.params : {};
        const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
        return respond({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "rhen", version: ctx.serverVersion, contractVersion: AGENT_CONTRACT_VERSION },
          instructions: serverInstructions()
        });
      }
      case "notifications/initialized":
        return null;
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: ctx.tools });
      case "tools/call":
        return respond(await handleToolsCall(parsed.params, ctx));
      default:
        return respondError(-32601, "Method not found");
    }
  } catch (error) {
    if (error instanceof McpProtocolError) return respondError(error.code, error.message);
    return respondError(-32603, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs the newline-delimited JSON-RPC loop until `input` ends. Kept as a pure function of its
 * options (no process.stdin/stdout) so tests can drive it with in-memory lines. Imports `registry.js`
 * and `cli.js` dynamically, exactly as `commands/help.ts` does, since the registry imports this module.
 */
export async function serveMcp(options: ServeMcpOptions): Promise<void> {
  // `mcp` itself is excluded from the tool table — serving the MCP server as a nested MCP tool makes
  // no sense — but every other command, including `help`, is exposed exactly as the shell would run it.
  const ctx = await buildLineContext({
    runner: options.runner,
    readOnly: options.readOnly,
    stateFile: options.stateFile,
    agent: options.agent,
    allowWrites: options.allowWrites,
    denyWrites: options.denyWrites,
    filesDir: options.filesDir
  });

  for await (const line of toLines(options.input)) {
    if (line.trim() === "") continue;
    const response = await handleLine(line, ctx);
    if (response !== null) options.write(response);
  }
}

export const mcpCommand: CommandSpec = {
  name: "mcp",
  summary: "Serve every command as MCP tools over stdio",
  description:
    "Runs an MCP (Model Context Protocol) server, so tools like Claude Desktop and ChatGPT desktop can call " +
    "every rhen command. Each command becomes one MCP tool that assembles the equivalent command line " +
    "and runs it exactly as the shell would. Defaults to stdio; --watch (development only) puts a small " +
    "supervisor in front of the stdio server that transparently restarts it when the built bundle changes on " +
    "disk, so an MCP client can stay connected across rebuilds instead of being relaunched by hand. --http " +
    "serves the same tool table over MCP's Streamable HTTP transport instead, for a client that takes a " +
    "remote endpoint and cannot spawn a local process (ChatGPT desktop's connectors, for example): bound to " +
    "127.0.0.1 only, requiring a bearer token from OPENRHEN_MCP_TOKEN (generated and printed once if unset), " +
    "and refusing any request whose Origin or Host is not loopback. The global --read-only and --state-file " +
    'options (see "rhen help") apply to the whole server: --read-only hides every mutating tool from ' +
    "tools/list and refuses one called by name anyway; --state-file <path> (which implies --read-only) also " +
    "serves every read tool from that saved `rhen state --json` snapshot and makes no network request " +
    "at all — that is how a reasoner reading the plan is kept from ever writing it or reaching a live portal. " +
    "--allow-writes a,b serves only those write tools (all read tools stay), and --deny-writes a,b hides and " +
    "refuses the named write tools; both take command names such as capture,session,check-in. They scope " +
    "whole tools: `save` can still write any entity type, so leave it out of an agent's scope you want kept narrow.",
  positionals: [],
  options: {
    watch: {
      type: "boolean",
      description:
        "Development only, stdio: auto-restart the server when the running script file changes on disk, " +
        "without dropping the client's connection. Same as setting OPENRHEN_MCP_WATCH=1."
    },
    http: {
      type: "boolean",
      description: "Serve over Streamable HTTP on 127.0.0.1 instead of stdio."
    },
    port: {
      type: "string",
      placeholder: "n",
      description: "Port for --http (default 8834)"
    },
    "allow-writes": {
      type: "string",
      placeholder: "a,b",
      description: "Serve only these write tools, e.g. capture,session; read tools are unaffected"
    },
    "deny-writes": {
      type: "string",
      placeholder: "a,b",
      description: "Hide and refuse these write tools, e.g. bulk,recurrence"
    }
  },
  mutates: true,
  offline: true,
  examples: [],
  async run(context, args) {
    // These two apply to the whole server, not to any one tool call, so they are read here from the
    // global options rather than declared on this command's own `options` (which would put them on
    // every tool's input schema instead — see `buildLineContext`'s doc comment).
    const readOnly = booleanOption(args.values, "read-only");
    const stateFile = stringOption(args.values, "state-file");
    const http = booleanOption(args.values, "http");
    const agentRaw = stringOption(args.values, "agent");
    if (http && agentRaw !== undefined)
      throw new CliError(
        "--agent names one client; over --http each request names itself with the X-OpenRhen-Agent header",
        EXIT.usage
      );
    const agent = agentRaw === undefined ? undefined : parseAgentName(agentRaw);
    const allowRaw = stringOption(args.values, "allow-writes");
    const denyRaw = stringOption(args.values, "deny-writes");
    const allowWrites = await parseWriteScope(allowRaw, "--allow-writes");
    const denyWrites = await parseWriteScope(denyRaw, "--deny-writes");
    if (http) {
      const portRaw = stringOption(args.values, "port");
      const port = portRaw !== undefined ? Number(portRaw) : 8834;
      if (!Number.isInteger(port) || port <= 0 || port > 65535)
        throw new CliError("--port must be a whole number between 1 and 65535.", EXIT.usage);
      const { startHttpMcpServer, resolveHttpToken } = await import("./mcp-http.js");
      const { token, generated } = resolveHttpToken(process.env);
      const server = await startHttpMcpServer({
        port,
        token,
        log: (line) => context.stderr(line),
        buildContext: () => buildLineContext({ readOnly, stateFile, allowWrites, denyWrites })
      });
      // After the bind, so a port already in use leaves an earlier token file alone; if the token cannot be
      // stored, close the server rather than keep serving with a token no one can find.
      let notice: string | undefined;
      try {
        notice = generated ? generatedTokenNotice(token, server.port) : undefined;
      } catch (error) {
        await server.close();
        throw error;
      }
      context.stderr(`rhen: MCP Streamable HTTP server listening on http://127.0.0.1:${server.port}`);
      if (notice !== undefined) context.stderr(notice);
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void server.close().then(resolve);
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      return;
    }
    const watch = booleanOption(args.values, "watch") || process.env.OPENRHEN_MCP_WATCH === "1";
    if (watch) {
      const { runSupervisor, createFileWatcher, createProcessChildFactory } = await import("./mcp-supervisor.js");
      const scriptPath = process.argv[1] ?? "";
      const extraArgs = [
        ...(readOnly ? ["--read-only"] : []),
        ...(stateFile !== undefined ? ["--state-file", stateFile] : []),
        ...(agent !== undefined ? ["--agent", agent] : []),
        ...(allowRaw !== undefined ? ["--allow-writes", allowRaw] : []),
        ...(denyRaw !== undefined ? ["--deny-writes", denyRaw] : [])
      ];
      await runSupervisor({
        spawnChild: createProcessChildFactory(scriptPath, extraArgs),
        watchFile: createFileWatcher(scriptPath),
        stdin: process.stdin,
        stdout: (line) => {
          process.stdout.write(`${line}\n`);
        },
        stderr: (line) => {
          process.stderr.write(`${line}\n`);
        }
      });
      return;
    }
    const { runCli } = await import("../cli.js");
    await serveMcp({
      input: process.stdin,
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
      // The owner token is the owner's own shell's; a tool call dispatched for an agent never carries it.
      runner: (argv, capture) => runCli(argv, { env: withoutOwnerToken(process.env), ...capture }),
      readOnly,
      stateFile,
      agent,
      allowWrites,
      denyWrites
    });
  }
};
