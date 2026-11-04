import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { buildInfo } from "../build-info.js";
import { booleanOption, type CommandContext, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { renderRecord, toJson } from "../output.js";
import { sameCommit } from "../staleness.js";
import { isBundled } from "./version.js";

const BANNER = "#!/usr/bin/env node";
const SMOKE_TIMEOUT_MS = 10_000;
const RESTART_NOTE =
  "A long-lived stdio MCP process keeps running the old code until its client restarts it; " +
  "a host that spawns the CLI per call picks the new bundle up immediately.";

interface VersionInfo {
  commit: string | null;
  bundle: { available: boolean; sha256?: string; bytes?: number };
}

export interface SelfUpdateOptions {
  /** The running script (`process.argv[1]`); injected by tests. */
  scriptPath: string;
  check: boolean;
}

/** Exported so tests can point it at a temp file instead of the real running script. */
export async function selfUpdate(context: CommandContext, options: SelfUpdateOptions): Promise<void> {
  const { client } = context;
  const info = await client.get<VersionInfo>("/api/cli/version");
  if (!info?.bundle?.available)
    throw new CliError(
      "This portal has no CLI bundle to update from (GET /api/cli/version says none).",
      EXIT.unavailable
    );
  if (!isBundled(options.scriptPath))
    throw new CliError(
      `self-update replaces the built bundle, and this is not one (running ${options.scriptPath}). ` +
        "Run `git pull` and rebuild instead: `pnpm --filter @openrhen/cli build`.",
      EXIT.usage
    );
  if (!info.commit)
    throw new CliError(
      "The portal does not know its own commit, so there is nothing to compare this build with.",
      EXIT.unavailable
    );

  const from = buildInfo.commit;
  const to = info.commit;
  const upToDate = from !== "dev" && sameCommit(from, to);
  if (upToDate || options.check) {
    emit(context, {
      status: upToDate ? "up-to-date" : "update-available",
      from,
      to,
      bytes: info.bundle.bytes ?? null,
      written: false
    });
    return;
  }

  if (!client.getBinary)
    throw new CliError("This client cannot download files; self-update needs a connected portal.", EXIT.usage);
  if (!trustedChannel(client.baseUrl))
    throw new CliError(
      `self-update downloads code it then runs, so it needs a verified HTTPS portal address, not ${client.baseUrl}: ` +
        "a device on the LAN could answer a plain-http request in the portal's place. Point the CLI at the portal's " +
        "HTTPS name (--url, OPENRHEN_URL or ~/.openrhen/config.json) and run it again.",
      EXIT.usage
    );
  const download = await client.getBinary("/api/cli/bundle");
  const sha = createHash("sha256").update(download.bytes).digest("hex");
  const advertised = download.headers["x-bundle-sha256"];
  if (!advertised || sha !== advertised || (info.bundle.sha256 !== undefined && sha !== info.bundle.sha256))
    throw new CliError("The downloaded bundle does not match its sha256; nothing was changed.", EXIT.unavailable);
  if (!Buffer.from(download.bytes.subarray(0, BANNER.length)).toString("utf8").startsWith(BANNER))
    throw new CliError(
      `The downloaded file is not a CLI bundle (no ${BANNER} banner); nothing was changed.`,
      EXIT.unavailable
    );

  const script = realpathSync(options.scriptPath);
  const mode = statSync(script).mode & 0o777;
  // Same extension as the script so Node reads the staged file as the module type the bundle is (.mjs).
  const staged = script.replace(/(\.[^./\\]+)?$/, ".new$1");
  const backupPath = `${script}.bak`;
  try {
    writeFileSync(staged, download.bytes);
    chmodSync(staged, mode);
    // A bundle that passes sha and banner but cannot start would replace the one tool that could fix it.
    try {
      execFileSync(process.execPath, [staged, "version"], {
        stdio: "ignore",
        timeout: SMOKE_TIMEOUT_MS,
        env: smokeEnvironment()
      });
    } catch {
      throw new CliError(
        "The downloaded bundle failed to start (`version` did not run); nothing was changed.",
        EXIT.unavailable
      );
    }
    copyFileSync(script, backupPath);
    renameSync(staged, script);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }

  emit(context, {
    status: "updated",
    from,
    to,
    bytes: download.bytes.length,
    written: true,
    backupPath,
    note: RESTART_NOTE
  });
}

/** HTTPS (Node verifies the certificate) or this machine itself; plain http anywhere else can be spoofed. */
export function trustedChannel(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  return url.protocol === "http:" && loopback;
}

/**
 * The staged bundle runs before it is trusted, so it gets only what Node needs to start: no agent token,
 * no MCP client environment, no secrets.
 */
function smokeEnvironment(): NodeJS.ProcessEnv {
  // A bare object on purpose; some consumers (the portal) type `NODE_ENV` as required, which this must not set.
  const env = {} as NodeJS.ProcessEnv;
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function emit(context: CommandContext, record: Record<string, unknown>): void {
  context.stdout(context.mode === "table" ? renderRecord(record) : toJson(record, context.mode === "json"));
}

export const selfUpdateCommand: CommandSpec = {
  name: "self-update",
  summary: "Replace this CLI bundle with the one the portal serves",
  description:
    "Compares this build's commit with the portal's and, when they differ, downloads the portal's CLI bundle, checks its " +
    "sha256 and banner, starts it once with an empty environment to confirm it runs, keeps the old file as <script>.bak, and swaps the new one in atomically. " +
    "It downloads only from an HTTPS portal address (or this machine), never over plain http. Only a built bundle " +
    "can be updated (a source checkout needs `git pull` and a rebuild). --check reports without writing. It never " +
    "runs by itself: run it on purpose when the CLI warns it differs from the portal.",
  positionals: [],
  options: {
    check: { type: "boolean", description: "Report whether an update is available without writing anything" }
  },
  // Changes only the local bundle file, never portal state, so it stays available in --read-only MCP servers.
  mutates: false,
  // ...but it does replace the running CLI, so a client that auto-approves read-only tools must still ask.
  localWrite: true,
  offline: false,
  examples: ["self-update", "self-update --check", "self-update --json"],
  async run(context, args) {
    await selfUpdate(context, { scriptPath: process.argv[1] ?? "", check: booleanOption(args.values, "check") });
  }
};
