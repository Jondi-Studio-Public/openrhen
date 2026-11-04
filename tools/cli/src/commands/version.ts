import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { buildInfo } from "../build-info.js";
import type { CommandSpec } from "../command.js";
import { renderRecord, toJson } from "../output.js";
import { localiseInstant } from "../when.js";

/**
 * Captured once, right after this module is first imported — an approximation of process start time
 * good enough for "how long has this MCP server been up", which is all `uptimeSeconds` needs.
 */
const STARTED_AT = new Date();

/** The script path a real run carries (`process.argv[1]`) ends in `.ts` under `tsx`/vitest, and in a
 * bundled extension (`.mjs`/`.cjs`/`.js`) once esbuild has produced `dist/rhen.mjs`. */
export function isBundled(scriptPath: string): boolean {
  return /\.(?:mjs|cjs|js)$/.test(scriptPath);
}

/**
 * `version` is offline — there is no portal settings timezone to localise into, unlike every other
 * command — so it uses the machine's own zone instead. Exported so tests can pass a fixed zone
 * rather than depending on whatever zone the test runner's host happens to be in.
 */
export function resolveTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length > 0 ? zone : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Exported so tests can inject a fixed `timeZone` instead of depending on the host machine's own. */
export function buildVersionInfo(timeZone: string) {
  const scriptPath = process.argv[1] ?? "";
  return {
    version: buildInfo.version,
    commit: buildInfo.commit,
    builtAt: buildInfo.builtAt ? localiseInstant(buildInfo.builtAt, timeZone) : null,
    script: scriptPath,
    startedAt: localiseInstant(STARTED_AT.toISOString(), timeZone),
    timeZone,
    uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
    node: process.version,
    bundled: isBundled(scriptPath)
  };
}

export const versionCommand: CommandSpec = {
  name: "version",
  summary: "Print the build version, commit, and runtime info",
  description:
    "Prints the package version and the git commit/timestamp the running bundle was built from, alongside the " +
    "script path, Node version, and uptime of this process. builtAt and startedAt are localised into the " +
    "machine's own timezone (named in the timeZone field) since this command is offline and has no portal " +
    "settings timezone to use. Useful for confirming which build an MCP client is actually talking to, " +
    "especially right after `mcp --watch` swaps in a rebuilt server.",
  positionals: [],
  options: {},
  mutates: false,
  offline: true,
  examples: ["version", "version --json"],
  async run(context) {
    const info = buildVersionInfo(resolveTimeZone());
    if (context.mode === "table") {
      context.stdout(renderRecord(info));
      return;
    }
    context.stdout(toJson(info, context.mode === "json"));
  }
};
