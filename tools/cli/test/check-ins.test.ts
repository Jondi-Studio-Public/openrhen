import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  version: 2,
  answeredAt: "2026-09-03T01:00:00.000Z",
  status: "deviated",
  deviationNote: "school run",
  tags: [],
  ...extra
});

async function run(argv: string[], answered: unknown = { checkIns: [], next: null }) {
  const calls: RecordedCall[] = [];
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["check-ins", ...argv], {
    stdout: (text) => {
      stdout += `${text}\n`;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(
      { "/api/state": { body: { state: fixtureRawState() } }, "/api/check-ins/answered": { body: answered } },
      calls
    )
  });
  return { exitCode, stdout, stderr, calls };
}

const answeredCall = (calls: RecordedCall[]) => calls.find((call) => call.url.includes("/api/check-ins/answered"));

describe("check-ins", () => {
  it("asks for 20 rows by default and prints the ids", async () => {
    const { exitCode, stdout, calls } = await run([], {
      checkIns: [row("c1", { tags: [{ tag: "family", mark: "inferred" }] })],
      next: null
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(answeredCall(calls)?.url).toMatch(/\/api\/check-ins\/answered\?limit=20$/);
    expect(stdout).toContain("c1");
    expect(stdout).toContain("family");
    expect(stdout).not.toContain("More:");
  });

  it("sends the filters, the limit and the cursor", async () => {
    const { calls } = await run(["--untagged", "--with-words", "--limit", "5", "--cursor", "abc_-"]);
    const url = new URL(answeredCall(calls)?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "5",
      untagged: "1",
      "with-words": "1",
      cursor: "abc_-"
    });
  });

  it("ends a full page with the cursor to repeat", async () => {
    const { stdout } = await run([], { checkIns: [row("c1")], next: "CURSOR" });
    expect(stdout).toContain("More: --cursor CURSOR");
  });

  it("prints the whole result in --json", async () => {
    const { stdout } = await run(["--json"], { checkIns: [row("c1")], next: "CURSOR" });
    const parsed = JSON.parse(stdout) as { checkIns: { id: string; version: number }[]; next: string };
    expect(parsed.checkIns[0]).toMatchObject({ id: "c1", version: 2 });
    expect(parsed.next).toBe("CURSOR");
  });

  it("refuses a limit over 100", async () => {
    const result = await run(["--limit", "101"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("at most 100");
  });

  it("sends since and before, and refuses before with a cursor", async () => {
    const { calls } = await run(["--since", "2026-11-01T00:00:00Z", "--before", "2026-11-09T00:00:00Z"]);
    const url = new URL(answeredCall(calls)?.url ?? "");
    expect(url.searchParams.get("since")).toBe("2026-11-01T00:00:00Z");
    expect(url.searchParams.get("before")).toBe("2026-11-09T00:00:00Z");
    const both = await run(["--before", "2026-11-09T00:00:00Z", "--cursor", "abc"]);
    expect(both.exitCode).toBe(EXIT.usage);
    expect(both.stderr).toContain("--cursor or --before");
    expect(answeredCall(both.calls)).toBeUndefined();
  });
});
