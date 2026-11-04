import type { StoredLinkSource } from "./plan-map/stored-links.js";
import { fileJournal, memoryJournal, type Journal } from "./undo-journal.js";
import { resolveAgent, resolveClaim, resolveOwner, resolveOwnerToken, resolveToken, type WriteClaim } from "./agent.js";
import { buildInfo } from "./build-info.js";
import { createClient, type PortalClient } from "./client.js";
import {
  booleanOption,
  outputMode,
  parseCommandArgs,
  stringOption,
  type CommandContext,
  type CommandSpec
} from "./command.js";
import { renderCommandHelp, renderOverview } from "./commands/help.js";
import { defaultConfigSources, resolveConfig, type ConfigSources } from "./config.js";
import { REENTRY_REQUIRED_INSTRUCTION, type PulseReentryView } from "@openrhen/contracts";
import { CliError, EXIT } from "./errors.js";
import { describeIssues } from "./issues.js";
import { stripTerminalControls, toJson, type OutputMode } from "./output.js";
import { commandKeyUsed, parseCommandIdKey, usedCommandKey } from "./write.js";
import { commands, findCommand } from "./registry.js";
import { staleNote } from "./staleness.js";
import { createSnapshotClient } from "./snapshot-client.js";

export const CLI_VERSION = buildInfo.version;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  readConfigFile?: ConfigSources["readConfigFile"];
  /** Reads a `--state-file` snapshot's raw text. Defaults to a real filesystem read; tests inject a stub. */
  readStateFile?: ((path: string) => string) | undefined;
  /** Where `map` reads stored plan links from; tests inject one. Defaults to the portal's `GET /api/plan-map`. */
  storedLinks?: StoredLinkSource | undefined;
  /**
   * Where reversible writes are recorded for `undo`. Defaults to `~/.openrhen/undo-log.json` for a real
   * run; a caller that injects its own config source (every test) gets an in-memory one, so no test
   * touches a home directory.
   */
  journal?: Journal | undefined;
  /** The run is the signed-in person's, made by the portal's owner-only routes; see `CommandContext.byOwner`. */
  byOwner?: boolean | undefined;
  /**
   * The run is the portal's remote `/mcp` (or another in-process caller), which serves fewer commands than the stdio
   * CLI: JSON output is printed compact (pretty printing is a quarter of a status answer) and `state` needs a small
   * `--key`. Terminal and stdio runs leave it unset.
   */
  remote?: boolean | undefined;
  /** The run serves an MCP agent (the stdio `mcp` server sets it per call; `remote` implies it): hints name tool calls, not commands. */
  mcp?: boolean | undefined;
}

/** `text` re-printed without indentation when it is one JSON object or array; anything else comes back as given. */
function compactJsonText(text: string): string {
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * Runs one invocation and returns its exit code. Everything a test needs to control comes in
 * through `io`, so the whole CLI can be exercised without a process, a network, or a home directory.
 */
export async function runCli(rawArgv: readonly string[], rawIo: CliIo): Promise<number> {
  // `pnpm cli -- status` hands the separator on; it is never a command or an option here.
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const [first, ...rest] = argv;
  let mode: OutputMode = "table";
  let flagNames: string[] = [];
  // Table output and stderr are read on a terminal, so untrusted text loses its control characters
  // there; JSON keeps every byte (its own escaping already covers C0).
  const io: CliIo = {
    ...rawIo,
    stdout: (text) =>
      rawIo.stdout(
        mode === "table" ? stripTerminalControls(text) : rawIo.remote === true ? compactJsonText(text) : text
      ),
    stderr: (text) => rawIo.stderr(stripTerminalControls(text))
  };
  if (first === undefined || first === "--help" || first === "-h") {
    io.stdout(renderOverview(commands));
    return EXIT.ok;
  }
  if (first === "--version" || first === "-v") {
    io.stdout(`rhen ${CLI_VERSION}`);
    return EXIT.ok;
  }

  // Reached from the catch: a write that may have landed is repeated with the key it used.
  let context: CommandContext | undefined;
  try {
    if (first.startsWith("-"))
      throw new CliError(`Unknown option ${first}. The command comes first: rhen <command> [options].`);
    const spec = findCommand(first);
    if (!spec)
      throw new CliError(
        `Unknown command "${first}". Commands: ${commands.map((command) => command.name).join(", ")}.`
      );
    flagNames = Object.keys(spec.options);
    const args = parseCommandArgs(spec, rest);
    mode = outputMode(args.values);
    if (booleanOption(args.values, "help")) {
      io.stdout(renderCommandHelp(spec));
      return EXIT.ok;
    }
    const stateFile = stringOption(args.values, "state-file");
    const readOnly = booleanOption(args.values, "read-only") || stateFile !== undefined;
    // `mcp` is exempt: its own --read-only/--state-file describe the tool table it serves to a client,
    // not a write it is about to make itself, and it never gets a client at all (it is `offline: true`).
    // Every other offline command (guide, schema, help, version) never talks to the portal either, so
    // the restriction has nothing to protect against for them.
    if (readOnly && spec.mutates && !spec.offline)
      throw new CliError(
        stateFile !== undefined
          ? `"${spec.name}" changes portal state and cannot run with --state-file (which implies --read-only).`
          : `"${spec.name}" changes portal state and cannot run with --read-only.`,
        EXIT.usage
      );
    const commandKey = parseCommandIdKey(args.values);
    if (commandKey !== undefined && !spec.mutates)
      throw new CliError(`--command-id only applies to commands that change portal state; "${spec.name}" does not.`);
    const agent = resolveAgent(args.values, io.env ?? process.env, spec.name);
    const claim = resolveClaim(spec, args.values);
    let exitCode: number = EXIT.ok;
    context = {
      client: spec.offline
        ? offlineClient(spec)
        : stateFile !== undefined
          ? createSnapshotClient(stateFile, { readFile: io.readStateFile })
          : connectedClient(spec, args.values, io, readOnly, agent, claim),
      mode,
      now: io.now ?? (() => new Date()),
      storedLinks: io.storedLinks,
      journal: io.journal ?? (io.readConfigFile ? memoryJournal() : fileJournal()),
      owner: resolveOwner(agent, io.env ?? process.env),
      byOwner: io.byOwner === true,
      remote: io.remote === true,
      mcp: io.mcp === true || io.remote === true,
      hasToken: resolveToken(io.env ?? process.env) !== undefined,
      stdout: io.stdout,
      stderr: io.stderr,
      setExitCode: (code) => {
        exitCode = code;
      }
    };
    await spec.run(context, args);
    // The three commands that never touch the plan still carry the notice when the pulse has lapsed.
    if (NOTICE_ONLY.has(spec.name) && stateFile === undefined && (agent !== undefined || context.hasToken))
      await reentryNotice(spec, args.values, io, agent, claim);
    // Never an error and never on stdout: JSON output stays clean, and an MCP host shows it as a note.
    // `version` and `self-update` say so themselves, so the note would only repeat them.
    if (spec.name !== "version" && spec.name !== "self-update") {
      const note = staleNote(context.client.serverCommit?.());
      if (note) io.stderr(note);
    }
    if (commandKey !== undefined && !commandKeyUsed(context))
      io.stderr(
        `rhen: "${spec.name}" sent no write that carries a command id, so --command-id had no effect; ` +
          "repeating it is not deduplicated."
      );
    return exitCode;
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError(error instanceof Error ? error.message : String(error), EXIT.unavailable);
    if (mode === "table") {
      // A write that failed names the command id it used, so a repeat can carry it.
      const key = failure.agent.commandId ?? (context === undefined ? undefined : usedCommandKey(context));
      io.stderr(
        `rhen: ${failure.message}${key === undefined || failure.exitCode === EXIT.conflict || failure.message.includes(key) ? "" : ` (command id ${key})`}`
      );
      if (failure.details !== undefined) {
        const lines = describeIssues(failure.details, flagNames);
        if (lines) for (const line of lines) io.stderr(`  ${line}`);
        else io.stderr(toJson(failure.details, true));
      }
    } else {
      io.stdout(
        toJson(
          {
            error: failure.message,
            exitCode: failure.exitCode,
            details: failure.details ?? null,
            ...doubtfulKey(failure, context),
            ...failure.agent
          },
          true
        )
      );
    }
    return failure.exitCode;
  }
}

/** Commands that read no plan data, so a lapsed pulse does not refuse them; they only say it has. */
const NOTICE_ONLY = new Set(["guide", "help", "version"]);

/** A line on stderr when the pulse is `off/lapsed`: never an error, never on stdout, and silent when the portal cannot be asked quickly. */
async function reentryNotice(
  spec: CommandSpec,
  values: Parameters<typeof stringOption>[0],
  io: CliIo,
  agent: string | undefined,
  claim: WriteClaim
): Promise<void> {
  try {
    const client = connectedClient(spec, { ...values, timeout: "1500" }, io, true, agent, claim);
    const read = await client.get<{ pulse?: PulseReentryView | null; lapsed?: boolean }>("/api/pulse/reentry?brief=1");
    if (read?.lapsed && read.pulse)
      io.stderr(`rhen: ${REENTRY_REQUIRED_INSTRUCTION} Still needed: ${read.pulse.reentry.missing.join("; ")}.`);
  } catch {
    /* the notice is a courtesy; the gate itself speaks on the next real call */
  }
}

function connectedClient(
  spec: CommandSpec,
  values: Parameters<typeof stringOption>[0],
  io: CliIo,
  readOnly: boolean,
  agent: string | undefined,
  claim: WriteClaim
): PortalClient {
  void spec;
  const allowPublic = booleanOption(values, "allow-public");
  const config = resolveConfig(
    {
      url: stringOption(values, "url"),
      timeout: stringOption(values, "timeout"),
      ...(allowPublic ? { allowPublic } : {})
    },
    { env: io.env ?? process.env, readConfigFile: io.readConfigFile ?? defaultConfigSources().readConfigFile }
  );
  return createClient(config, {
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    warn: io.stderr,
    readOnly,
    agent,
    claim,
    token: resolveToken(io.env ?? process.env),
    ownerToken: resolveOwnerToken(io.env ?? process.env, agent)
  });
}

function offlineClient(spec: CommandSpec): PortalClient {
  const refuse = () => {
    throw new CliError(`"${spec.name}" is an offline command and must not call the portal.`, EXIT.unavailable);
  };
  return { baseUrl: "", getState: async () => refuse(), get: async () => refuse(), post: async () => refuse() };
}

/**
 * The command id an `unavailable` failure may be repeated with: the key the invocation's writes carried, so the
 * portal's receipt makes a repeat a no-op if the first landed. None when no write was keyed, since a repeat with
 * that id would not be deduplicated.
 */
function doubtfulKey(failure: CliError, context: CommandContext | undefined): { commandId?: string } {
  if (failure.exitCode !== EXIT.unavailable || context === undefined) return {};
  const key = usedCommandKey(context);
  return key === undefined ? {} : { commandId: key };
}
