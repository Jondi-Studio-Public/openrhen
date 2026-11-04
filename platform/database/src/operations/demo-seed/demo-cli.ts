import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drives `tools/cli` as a child process, the same way a person or an agent would: the seed reads and
 * writes only through the portal's HTTP routes, so everything it creates passes the portal's own
 * validation. (A spawn, not an import, because platform code may not depend on the CLI package.)
 */
const CLI_DIR = fileURLToPath(new URL("../../../../../tools/cli", import.meta.url));

/**
 * `DEMO_SEED_CLI` names a built CLI bundle (`pnpm --filter @openrhen/cli build` writes
 * `tools/cli/dist/rhen.mjs`) to run in place of the source under tsx. That starts about 0.5 s
 * sooner per call, which over the seed's couple of hundred calls is minutes; the production smoke's
 * seed phase sets it. Unset, the seed runs the source as it always has.
 */
const builtCli = () => process.env.DEMO_SEED_CLI?.trim() || undefined;

export type CliResult = { code: number; stdout: string; stderr: string };

export type DemoCli = {
  run(args: readonly string[]): CliResult;
  /** Runs a command that must succeed and returns the first line of its output, for the log. */
  ok(args: readonly string[]): string;
  /** Runs a `--json` command that must succeed and returns the parsed output. */
  json<T = unknown>(args: readonly string[]): T;
  /** Writes a payload to a temp file and returns its absolute path, for `--from`. */
  file(payload: unknown): string;
  cleanup(): void;
};

/** `--set key=value` pairs: strings go through as typed, everything else as JSON. */
export function setArgs(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).flatMap(([key, value]) =>
    value === undefined ? [] : ["--set", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`]
  );
}

export function createCli(portalUrl: string): DemoCli {
  const scratch = mkdtempSync(join(tmpdir(), "openrhen-demo-seed-"));
  mkdirSync(scratch, { recursive: true });
  let counter = 0;
  const run = (args: readonly string[]): CliResult => {
    const bundle = builtCli();
    const command = bundle ? [bundle] : ["--import", "tsx", "src/main.ts"];
    const result = spawnSync(process.execPath, [...command, ...args], {
      cwd: CLI_DIR,
      // A home of its own, so the seed's couple of hundred writes never land in the person's real
      // ~/.openrhen undo journal (evicting their history) and their config file never steers it.
      env: {
        ...process.env,
        HOME: scratch,
        USERPROFILE: scratch,
        OPENRHEN_URL: portalUrl,
        OPENRHEN_TIMEOUT_MS: "60000"
      },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024
    });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const failure = (args: readonly string[], result: CliResult) =>
    new Error(
      `rhen ${args.slice(0, 3).join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`
    );
  return {
    run,
    ok(args) {
      const result = run(args);
      if (result.code !== 0) throw failure(args, result);
      return result.stdout.split("\n")[0]?.trim() ?? "";
    },
    json<T>(args: readonly string[]) {
      const result = run([...args, "--json"]);
      if (result.code !== 0) throw failure(args, result);
      return JSON.parse(result.stdout) as T;
    },
    file(payload) {
      counter += 1;
      const path = join(scratch, `payload-${counter}.json`);
      writeFileSync(path, JSON.stringify(payload));
      return path;
    },
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}
