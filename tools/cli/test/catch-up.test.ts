import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const ledger = {
  now: "2026-09-04T00:00:00.000Z",
  since: "2026-09-01T00:00:00.000Z",
  due: true,
  unsettled: 2,
  staleDates: 1,
  entries: [
    {
      id: "occurrence:o1",
      kind: "occurrence",
      title: "Gym",
      question: null,
      verdicts: ["done", "skipped", "dropped", "pending"],
      atRequired: [],
      plannedAt: "2026-09-02T09:00:00.000Z",
      localDate: "2026-09-02",
      projectId: null,
      version: null
    },
    {
      id: "deadline:p1",
      kind: "self_set_deadline",
      title: "Thesis draft",
      question: null,
      verdicts: ["done", "skipped", "dropped", "pending"],
      atRequired: [],
      plannedAt: "2026-09-03T09:00:00.000Z",
      localDate: null,
      projectId: "p1",
      version: 4
    },
    {
      id: "session:s1",
      kind: "open_session",
      title: "Write report",
      question: "Did Write report finish?",
      verdicts: ["done", "ended", "skipped", "pending"],
      atRequired: ["done", "ended"],
      plannedAt: "2026-09-03T10:00:00.000Z",
      localDate: null,
      projectId: null,
      version: 2
    }
  ],
  remaining: 7,
  nextOffset: 52
};
const UUID = "11111111-1111-4111-8111-111111111111";
const VERDICTS = '[{"entryId":"occurrence:o1","verdict":"done"}]';

describe("registry", () => {
  it("lists catch-up as a read command and catch-up-settle as a write", () => {
    expect(commands.find((c) => c.name === "catch-up")?.mutates).toBe(false);
    expect(commands.find((c) => c.name === "catch-up-settle")?.mutates).toBe(true);
  });
});

describe("catch-up", () => {
  it("reads the ledger with since and offset, and only ever GETs", async () => {
    const { exitCode, stdout, calls } = await run(["catch-up", "--since", "2026-08-01T00:00:00Z", "--offset", "50"], {
      "/api/catch-up": { body: ledger }
    });
    expect(exitCode).toBe(EXIT.ok);
    const url = new URL(calls.find((c) => c.path === "/api/catch-up")!.url);
    expect(url.searchParams.get("since")).toBe("2026-08-01T00:00:00Z");
    expect(url.searchParams.get("offset")).toBe("50");
    expect(stdout).toContain("Catch-up is due.");
    expect(stdout).toContain("2 unsettled, 1 stale date.");
    expect(stdout).toContain("deadline:p1");
    // The server's next offset, not offset + entries shown: the open session rides as an extra.
    expect(stdout).toContain("--offset 52");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("shows an open session with its question, verdicts and which need a time", async () => {
    const { stdout } = await run(["catch-up"], { "/api/catch-up": { body: ledger } });
    expect(stdout).toContain("session:s1");
    expect(stdout).toContain("open_session");
    expect(stdout).toContain("done* ended* skipped pending");
    expect(stdout).toContain("session:s1: Did Write report finish?");
    expect(stdout).toContain("* needs");
  });

  it("prints JSON, and works under --read-only", async () => {
    const { exitCode, stdout } = await run(["catch-up", "--json", "--read-only"], {
      "/api/catch-up": { body: ledger }
    });
    expect(exitCode).toBe(EXIT.ok);
    const json = JSON.parse(stdout);
    expect(json.unsettled).toBe(2);
    expect(json.staleDates).toBe(1);
    expect(json.entries).toHaveLength(3);
    expect(json.entries[2].verdicts).toEqual(["done", "ended", "skipped", "pending"]);
  });

  it("refuses a bad --since, a bad --offset and --state-file", async () => {
    expect((await run(["catch-up", "--since", "yesterday"])).exitCode).toBe(EXIT.usage);
    expect((await run(["catch-up", "--offset", "-1"])).exitCode).toBe(EXIT.usage);
    expect((await run(["catch-up", "--state-file", "x.json"])).exitCode).not.toBe(EXIT.ok);
  });
});

describe("catch-up-settle", () => {
  const route = "/api/commands/catch-up-settle";

  it("posts the verdicts with a command id, basis and evidence", async () => {
    const { exitCode, stdout, calls } = await run(
      [
        "catch-up-settle",
        "--verdicts-json",
        VERDICTS,
        "--basis",
        "stated",
        "--evidence",
        "did it Tuesday",
        "--note",
        "went late",
        "--close-window",
        "--command-id",
        UUID
      ],
      { [route]: { body: { results: [{ entryId: "occurrence:o1", outcome: "applied" }], closed: true, remaining: 0 } } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(route);
    expect(post.body).toMatchObject({
      commandId: UUID,
      verdicts: [{ entryId: "occurrence:o1", verdict: "done" }],
      closeWindow: true,
      basis: "stated",
      evidence: "did it Tuesday",
      note: "went late"
    });
    expect(stdout).toContain("Settled: 1 applied. Window closed.");
  });

  it("surfaces the 202 proposal as not applied", async () => {
    const { exitCode, stdout } = await run(["catch-up-settle", "--verdicts-json", VERDICTS], {
      [route]: {
        status: 202,
        body: { proposal: { id: "prop-1", status: "pending", summary: "Settle 1" }, outcome: "created" }
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Proposed prop-1: not applied");
    expect(stdout).toContain("From agents");
  });

  it("fails a settle whose only problem is a conflict, naming the entry", async () => {
    const { exitCode, stderr } = await run(["catch-up-settle", "--verdicts-json", VERDICTS], {
      [route]: {
        body: {
          results: [{ entryId: "deadline:p1", outcome: "conflict", message: "changed" }],
          closed: false,
          remaining: 3
        }
      }
    });
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("deadline:p1");
    expect(stderr).toContain("changed");
    expect(stderr).toContain("rhen_catch_up");
  });

  it("builds a bulk verdict, reads --from, and dry-runs without posting", async () => {
    const bulk = await run(["catch-up-settle", "--bulk", "all_skipped", "--day", "2026-09-02", "--dry-run"]);
    expect(bulk.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(bulk.stdout).payload.verdicts).toEqual([{ bulk: "all_skipped", day: "2026-09-02" }]);
    expect(bulk.calls.some((c) => c.method === "POST")).toBe(false);

    const file = join(tmpdir(), `catch-up-${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ verdicts: [{ bulk: "all_dropped", projectId: "p1" }] }));
    const from = await run(["catch-up-settle", "--from", file, "--dry-run"]);
    expect(JSON.parse(from.stdout).payload.verdicts).toEqual([{ bulk: "all_dropped", projectId: "p1" }]);
  });

  it("builds skip_older_than and an ended session verdict", async () => {
    const older = await run(["catch-up-settle", "--bulk", "skip_older_than", "--days", "7", "--dry-run"]);
    expect(older.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(older.stdout).payload.verdicts).toEqual([{ bulk: "skip_older_than", days: 7 }]);
    const ended = await run([
      "catch-up-settle",
      "--verdicts-json",
      '[{"entryId":"session:s1","verdict":"ended","at":"2026-09-03T11:00:00+10:00","remainingMinutes":20}]',
      "--dry-run"
    ]);
    expect(ended.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(ended.stdout).payload.verdicts[0]).toMatchObject({ verdict: "ended", remainingMinutes: 20 });
  });

  it("refuses invalid input before sending anything", async () => {
    for (const argv of [
      ["catch-up-settle"],
      ["catch-up-settle", "--verdicts-json", VERDICTS, "--bulk", "all_skipped"],
      ["catch-up-settle", "--verdicts-json", "{}"],
      ["catch-up-settle", "--bulk", "all_dropped"],
      ["catch-up-settle", "--bulk", "everything"],
      ["catch-up-settle", "--bulk", "skip_older_than"],
      ["catch-up-settle", "--bulk", "skip_older_than", "--days", "-1"],
      ["catch-up-settle", "--bulk", "skip_older_than", "--days", "2.5"],
      ["catch-up-settle", "--bulk", "skip_older_than", "--days", "7", "--day", "2026-09-02"],
      ["catch-up-settle", "--bulk", "skip_older_than", "--days", "7", "--project", "p1"],
      ["catch-up-settle", "--bulk", "all_skipped", "--days", "7"],
      ["catch-up-settle", "--verdicts-json", VERDICTS, "--basis", "stated"]
    ]) {
      const { exitCode, calls } = await run(argv);
      expect(exitCode, argv.join(" ")).toBe(EXIT.usage);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("is refused under --read-only", async () => {
    const { exitCode, calls } = await run(["catch-up-settle", "--verdicts-json", VERDICTS, "--read-only"]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
