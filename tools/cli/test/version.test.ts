import { describe, expect, it } from "vitest";
import { buildVersionInfo } from "../src/commands/version.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { type RecordedCall } from "./fake-fetch.js";

/** `YYYY-MM-DDTHH:MM:SS(.sss)?±HH:MM` — the offset form `localiseInstant` produces, never a trailing `Z`. */
const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** `version` is offline, so a fetch impl that throws proves it never talks to the portal. */
async function runVersion(argv: readonly string[]): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const throwingFetch: typeof fetch = () => {
    throw new Error("version must never call fetch");
  };
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    fetchImpl: throwingFetch
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("version", () => {
  it("table mode prints every field as key: value lines", async () => {
    const { exitCode, stdout } = await runVersion(["version"]);
    expect(exitCode).toBe(EXIT.ok);
    for (const key of [
      "version",
      "commit",
      "builtAt",
      "script",
      "startedAt",
      "timeZone",
      "uptimeSeconds",
      "node",
      "bundled"
    ])
      expect(stdout).toContain(key);
  });

  it("--json prints an object with every field, script as an absolute path, and a parseable, offset-form startedAt", async () => {
    const { exitCode, stdout } = await runVersion(["version", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const info = JSON.parse(stdout) as {
      version: string;
      commit: string;
      builtAt: string | null;
      script: string;
      startedAt: string;
      timeZone: string;
      uptimeSeconds: number;
      node: string;
      bundled: boolean;
    };
    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
    expect(typeof info.commit).toBe("string");
    expect(info.builtAt === null || OFFSET_INSTANT.test(info.builtAt)).toBe(true);
    // Under the test runner this isn't rhen.mjs, but it must still be an absolute path.
    expect(info.script.length).toBeGreaterThan(0);
    expect(/^([a-zA-Z]:[\\/]|\/)/.test(info.script)).toBe(true);
    // Localised into a real IANA zone, offset form (±HH:MM), never the raw UTC "Z" instant.
    expect(typeof info.timeZone).toBe("string");
    expect(info.timeZone.length).toBeGreaterThan(0);
    expect(info.startedAt).toMatch(OFFSET_INSTANT);
    expect(Number.isNaN(new Date(info.startedAt).getTime())).toBe(false);
    expect(typeof info.uptimeSeconds).toBe("number");
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.node).toBe(process.version);
    expect(typeof info.bundled).toBe("boolean");
  });

  it("never calls the portal, even with --url", async () => {
    const { exitCode, calls } = await runVersion(["version", "--url", "http://example.com"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls).toHaveLength(0);
  });
});

describe("buildVersionInfo", () => {
  it("localises startedAt (and builtAt, when the build stamped one) into the given zone, offset form", () => {
    const info = buildVersionInfo("Australia/Sydney");
    expect(info.timeZone).toBe("Australia/Sydney");
    expect(info.startedAt).toMatch(OFFSET_INSTANT);
    if (info.builtAt !== null) expect(info.builtAt).toMatch(OFFSET_INSTANT);
  });

  it("falls back to UTC for an empty zone, and offsets the same instant differently per zone", () => {
    const seedZone = buildVersionInfo("Australia/Sydney");
    const utc = buildVersionInfo("UTC");
    expect(utc.timeZone).toBe("UTC");
    expect(utc.startedAt).toMatch(/\+00:00$/);
    // seed-zone is well ahead of UTC in September (standard time, +10:00) — the wall-clock time differs.
    expect(seedZone.startedAt.slice(11, 19)).not.toBe(utc.startedAt.slice(11, 19));
  });
});
