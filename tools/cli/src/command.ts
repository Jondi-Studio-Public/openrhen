import { parseArgs, type ParseArgsConfig } from "node:util";
import { AGENT_BASES, closestNames, MAX_PLANNED_SESSION_MINUTES } from "@openrhen/contracts";
import type { PortalClient } from "./client.js";
import { CliError, EXIT } from "./errors.js";
import type { StoredLinkSource } from "./plan-map/stored-links.js";
import type { OutputMode } from "./output.js";
import type { UntrustedOutputKind } from "@openrhen/contracts";
import type { Journal } from "./undo-journal.js";

export interface CommandContext {
  client: PortalClient;
  mode: OutputMode;
  now: () => Date;
  /** Where `map` reads stored plan links from; absent means the portal's `GET /api/plan-map`. */
  storedLinks?: StoredLinkSource | undefined;
  /** The record of reversible writes behind `undo` and `redo`. */
  journal?: Journal | undefined;
  /** True when `OPENRHEN_TOKEN` is set: the portal then holds this run to the token's scopes, and a large bulk is filed as one proposal. */
  hasToken?: boolean | undefined;
  /** Who this run's writes are recorded as owned by, so `undo` only reverses its own (see `resolveOwner`). */
  owner?: string | undefined;
  /**
   * True only when the portal runs the command as the signed-in person (its owner-only routes), never from an
   * argument: `undo` then marks what it undid as the person's (`undoneBy`), which the agent cannot redo.
   */
  byOwner?: boolean | undefined;
  /**
   * True when the portal's remote `/mcp` runs the command in-process (set from `CliIo.remote`, never from an argument):
   * texts that name commands it does not serve are rewritten, output is compact JSON, `state` refuses to dump the whole
   * document, and an agent's refused undo names what it can do instead of `--force`.
   */
  remote?: boolean | undefined;
  /**
   * True when an MCP agent reads the output: the portal's remote `/mcp` (which implies `remote`) or the stdio `mcp` server
   * (which serves every command). Hints then name tool calls and arguments, never shell commands or `--flags`.
   */
  mcp?: boolean | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Sets the process exit code for a command that finishes normally (no thrown `CliError`) but still
   * needs to report something other than success — `bulk`, whose per-record failures are printed as
   * part of its own summary output rather than as a thrown error that would replace it. Unused by
   * every other command, which either succeeds (implicit `EXIT.ok`) or throws.
   */
  setExitCode: (code: number) => void;
  /**
   * Set by `changeset` while it builds: `postCommand` hands each write here, after stamping its command id, instead
   * of sending it, and the command then stops as it does after `--dry-run`.
   */
  collect?: ((write: { path: string; payload: Record<string, unknown>; summary: string }) => void) | undefined;
}

export type OptionValue = string | boolean | (string | boolean)[] | undefined;
export type OptionValues = Record<string, OptionValue>;

export interface ParsedArgs {
  positionals: string[];
  values: OptionValues;
}

export interface OptionSpec {
  type: "string" | "boolean";
  description: string;
  short?: string;
  /** Shown in help as `--name <placeholder>`. */
  placeholder?: string;
  multiple?: boolean;
  /**
   * The value is a path on this machine that the command reads or writes. Over MCP such a path must sit
   * inside `OPENRHEN_MCP_FILES_DIR`, so a model cannot read or write arbitrary local files through it.
   */
  localPath?: boolean;
  /**
   * The value's real JSON type over MCP, where a client sends a number or an object rather than text. The command
   * still reads it as text from argv: the MCP layer writes a number with `String` and an object or list as JSON.
   */
  mcp?: McpOptionType;
}

export type McpOptionType =
  | { type: "integer" | "number"; minimum?: number; maximum?: number }
  | { type: "object" }
  | { type: "array"; items: "object" };

export interface PositionalSpec {
  name: string;
  required: boolean;
  description: string;
  /** The values it accepts, published to MCP as the argument's enum (the CLI may also take aliases). */
  enum?: readonly string[];
  /** Optional on the command line (the CLI reports what is missing itself) but required in the MCP schema. */
  mcpRequired?: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** Longer explanation for `help <command>`; one or two sentences an AI tool can act on. */
  description: string;
  positionals: PositionalSpec[];
  options: Record<string, OptionSpec>;
  /** True when the command changes portal state. Read-only commands never send a POST. */
  mutates: boolean;
  /**
   * True when the command's main use removes or reverses data (undo, bulk, span, import, recurrence). MCP
   * serves it as `destructiveHint`; the hard floor in `@openrhen/contracts` decides what actually lands.
   */
  destructive?: boolean;
  /**
   * True for a command that changes a file on this machine but not portal state (`self-update` swaps the CLI bundle).
   * It stays out of `mutates`, so --read-only MCP servers keep it, but MCP must not call it read-only.
   */
  localWrite?: boolean;
  /** False when repeating the call is not a no-op (a second undo reverses the next write back). Becomes MCP `idempotentHint`. */
  idempotent?: false;
  /**
   * True for a command only the owner may run: it is never served over MCP and `--allow-writes` cannot name it,
   * so a model cannot reach it however its tools are scoped.
   */
  ownerOnly?: boolean;
  /** True when the command can send something to another person or service (a mail draft). Becomes MCP `openWorldHint`. */
  outward?: boolean;
  /**
   * The command's output carries text written by someone else (mail, other people's messages, an uploaded file). Over
   * MCP it is returned inside an untrusted-content fence so an injected instruction arrives as data.
   */
  untrustedOutput?: UntrustedOutputKind;
  /** Limits `untrustedOutput` to these values of the first positional (a subcommand or action); absent means every call. */
  untrustedActions?: readonly string[];
  /** True when the command never talks to the portal, so no URL is resolved or checked for it. */
  offline?: boolean;
  /** Examples shown in help, each a full command line without the program name. */
  examples: string[];
  run: (context: CommandContext, args: ParsedArgs) => Promise<void>;
}

/** A `--name` option read as a positive whole number; `required` is not offered because every caller has a default. */
export function parsePositiveInt(args: ParsedArgs, name: string): number | undefined {
  const raw = stringOption(args.values, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new CliError(`--${name} must be a positive whole number.`, EXIT.usage);
  return value;
}

/** Options every command accepts. Parsed before the command runs; commands see them in `values` too. */
export const globalOptions: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "Print JSON instead of a table or summary" },
  jsonl: { type: "boolean", description: "Print one JSON object per line (lists only)" },
  url: {
    type: "string",
    placeholder: "url",
    description: `Portal origin (default: OPENRHEN_URL, then ~/.openrhen/config.json, then http://localhost:8787)`
  },
  timeout: { type: "string", placeholder: "ms", description: "Request timeout in milliseconds (default 10000)" },
  "allow-public": {
    type: "boolean",
    description: "Permit a portal host that is not a LAN or private-network (VPN) address"
  },
  agent: {
    type: "string",
    placeholder: "name",
    description:
      "Name this client (1-32 of a-z 0-9 _ -; default: OPENRHEN_AGENT). Sent as X-OpenRhen-Agent so the " +
      "portal records who made each change; a self-declared label, not a credential"
  },
  "read-only": {
    type: "boolean",
    description:
      "Refuse any command that changes portal state, including an mcp tool called by name; a second guard " +
      "in the HTTP client also refuses any non-GET request"
  },
  "state-file": {
    type: "string",
    placeholder: "path",
    description:
      "Serve every read command from a saved `rhen state --json` snapshot instead of the portal; " +
      "implies --read-only and makes no network request at all"
  },
  "command-id": {
    type: "string",
    placeholder: "uuid",
    description: "Idempotency key (a uuid): repeating a write with the same key applies it at most once"
  },
  basis: {
    type: "string",
    placeholder: AGENT_BASES.join("|"),
    description:
      "stated (the person said it here; quote them in evidence), inferred (your guess) or observed (read from mail, a page or a file). Missing counts as inferred"
  },
  evidence: {
    type: "string",
    placeholder: "quote",
    description: "The person's own words for a stated write (at most 300 characters, no line breaks)"
  },
  help: { type: "boolean", short: "h", description: "Show help for this command" }
};

export function parseCommandArgs(spec: CommandSpec, argv: readonly string[]): ParsedArgs {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [name, option] of Object.entries({ ...globalOptions, ...spec.options }))
    options[name] = {
      type: option.type,
      ...(option.short ? { short: option.short } : {}),
      ...(option.multiple ? { multiple: true } : {})
    };
  try {
    const { values, positionals } = parseArgs({
      args: joinDashValues(argv, options),
      options,
      allowPositionals: true,
      strict: true
    });
    return { values: values as OptionValues, positionals };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Node's own text for a mistyped option ends with advice about positional arguments that is rarely the
    // cause; say which option it probably was instead.
    const unknown = /^Unknown option '(-{1,2}[^']+)'/.exec(raw);
    if (unknown?.[1]) {
      const typed = unknown[1];
      const close = closestNames(typed.replace(/^-+/, ""), Object.keys({ ...globalOptions, ...spec.options }));
      throw new CliError(
        `Unknown option ${typed}.${close.length > 0 ? ` Did you mean ${close.map((name) => `--${name}`).join(" or ")}?` : ""} ` +
          `Run "rhen help ${spec.name}" for usage.`,
        EXIT.usage
      );
    }
    throw new CliError(`${raw.replace(/\.$/, "")}. Run "rhen help ${spec.name}" for usage.`, EXIT.usage);
  }
}

/**
 * `--sort -deadlineAt` and `--since -7d` are natural to type, but node's parser reads a dash-led
 * value as another option. When a string option is followed by a token that is not an option we
 * know, fold the two into `--name=value`, which the parser accepts.
 */
export function joinDashValues(argv: readonly string[], options: NonNullable<ParseArgsConfig["options"]>): string[] {
  const shorts = new Set(
    Object.values(options)
      .map((option) => option.short)
      .filter((short): short is string => typeof short === "string")
  );
  const isKnownOption = (token: string) =>
    token === "--" ||
    (token.startsWith("--") && Object.hasOwn(options, token.slice(2).split("=", 1)[0] ?? "")) ||
    (/^-[^-]/.test(token) && shorts.has(token.slice(1, 2)));
  const joined: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      joined.push(...argv.slice(index));
      break;
    }
    const next = argv[index + 1];
    const name = token.startsWith("--") && !token.includes("=") ? token.slice(2) : undefined;
    if (
      name !== undefined &&
      options[name]?.type === "string" &&
      next !== undefined &&
      next.startsWith("-") &&
      !isKnownOption(next)
    ) {
      joined.push(`${token}=${next}`);
      index += 1;
      continue;
    }
    joined.push(token);
  }
  return joined;
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const last = value.at(-1);
    return last === undefined ? undefined : String(last);
  }
  return typeof value === "boolean" ? String(value) : value;
}

/** A `--name` option read as a positive whole number of minutes; `required` makes its absence a usage error. */
export function parseMinutes(args: ParsedArgs, name: string, required: true, tool?: string): number;
export function parseMinutes(args: ParsedArgs, name: string, required?: false, tool?: string): number | undefined;
export function parseMinutes(args: ParsedArgs, name: string, required = false, tool?: string): number | undefined {
  // `tool` is the MCP tool whose call the refusal tells an agent to repeat.
  const repeat = `Repeat the same ${tool ?? "call"} with ${name} set to a whole number from 1 to ${MAX_PLANNED_SESSION_MINUTES}`;
  const raw = stringOption(args.values, name);
  if (raw === undefined) {
    if (required)
      throw new CliError(
        `${name} is required: whole minutes from 1 to ${MAX_PLANNED_SESSION_MINUTES}, for example 15. ${repeat}.`,
        EXIT.usage
      );
    return undefined;
  }
  const text = raw.trim();
  const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PLANNED_SESSION_MINUTES)
    throw new CliError(
      `${name} "${raw}" is not valid: send whole minutes from 1 to ${MAX_PLANNED_SESSION_MINUTES}, for example 15. ${repeat}.`,
      EXIT.usage
    );
  return minutes;
}

export function booleanOption(values: OptionValues, name: string): boolean {
  const value = values[name];
  return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
}

export function requirePositional(spec: CommandSpec, args: ParsedArgs, index: number): string {
  const value = args.positionals[index];
  if (value !== undefined) return value;
  const positional = spec.positionals[index];
  throw new CliError(
    `Missing <${positional?.name ?? "argument"}>. Run "rhen help ${spec.name}" for usage.`,
    EXIT.usage
  );
}

export function outputMode(values: OptionValues): OutputMode {
  if (booleanOption(values, "jsonl")) return "jsonl";
  if (booleanOption(values, "json")) return "json";
  return "table";
}

/** Validates that a string is a parseable ISO 8601 datetime. */
export function validateIsoDateTime(value: string, name: string): string {
  try {
    const date = new Date(value);
    // Check if the date is valid (not NaN)
    if (isNaN(date.getTime())) {
      throw new CliError(`--${name} must be a valid ISO 8601 datetime, got "${value}".`, EXIT.usage);
    }
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`--${name} must be a valid ISO 8601 datetime, got "${value}".`, EXIT.usage);
  }
}
