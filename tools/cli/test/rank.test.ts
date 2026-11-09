import { buildConsequenceGroupView, rankConsequenceGroupCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const NEXT = "/api/consequence/next";
const ANSWER = "/api/commands/consequence";
const ID = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";

const group = buildConsequenceGroupView({
  groupId: "g-1",
  pool: "project",
  wording: "only_finish_one",
  reissued: false,
  items: [
    { id: "p-a", title: "Alpha", stars: 3 },
    { id: "p-b", title: "Bravo", stars: 3 },
    { id: "p-c", title: "Charlie", stars: 4 },
    { id: "p-d", title: "Delta", stars: 1 }
  ]
});
const recorded = {
  result: {
    comparisonId: "c-1",
    groupId: "g-1",
    replayed: false,
    by: "person",
    basis: "stated",
    next: "Recorded. Ask for the next group."
  }
};

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}, command = "rank") {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([command, ...(command === "inbox" ? [] : ["--command-id", ID]), ...argv], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(
      {
        "/api/state": { body: { state: fixtureRawState() } },
        [NEXT]: { body: { group } },
        [ANSWER]: { body: recorded },
        ...routes
      },
      calls
    )
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}
const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

describe("rank", () => {
  it("is a write tool that takes the numbers, --tie, --skip and --dry-run", async () => {
    const { commands } = await import("../src/registry.js");
    const spec = commands.find((command) => command.name === "rank");
    expect(spec?.mutates).toBe(true);
    expect(Object.keys(spec!.options)).toEqual(expect.arrayContaining(["tie", "skip", "pool", "group", "dry-run"]));
  });

  it("shows the next group with numbered items and how to answer, sending nothing", async () => {
    const { exitCode, stdout, calls } = await run([]);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("If you could only get one of these done, which would you do?");
    expect(stdout).toContain("1. Alpha (3 stars)");
    expect(stdout).toContain("4. Delta (1 star)");
    expect(stdout).toContain("rhen rank 1 2 3 4 --group g-1");
    expect(stdout).toContain("rhen rank --tie --group g-1");
    expect(stdout).toContain("rhen rank --skip");
    expect(stdout).toContain("groupId: g-1");
    expect(posts(calls)).toEqual([]);
  });

  it("says so when there is nothing to rank", async () => {
    const { exitCode, stdout } = await run([], { [NEXT]: { body: { group: null } } });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Nothing to rank right now");
  });

  it("answers with the numbers best first, mapping each to the group's id", async () => {
    const { exitCode, stdout, calls } = await run(["3", "1", "4", "2", "--group", "g-1"]);
    expect(exitCode).toBe(EXIT.ok);
    const [sent] = posts(calls);
    expect(sent!.path).toBe(ANSWER);
    expect(sent!.body).toEqual({ commandId: ID, groupId: "g-1", rankedIds: ["p-c", "p-a", "p-d", "p-b"] });
    expect(rankConsequenceGroupCommandSchema.safeParse(sent!.body).success).toBe(true);
    expect(stdout).toContain("Recorded.");
  });

  it("records --tie as a tie and --skip as a tie that says it was skipped", async () => {
    const tie = await run(["--tie", "--group", "g-1"]);
    expect(posts(tie.calls)[0]!.body).toEqual({ commandId: ID, groupId: "g-1", tie: true });
    const skip = await run(["--skip"]);
    expect(posts(skip.calls)[0]!.body).toEqual({ commandId: ID, groupId: "g-1", tie: true, evidence: "skipped" });
  });

  it("sends an agent's basis and evidence along", async () => {
    const { calls } = await run([
      "2",
      "1",
      "3",
      "4",
      "--group",
      "g-1",
      "--basis",
      "stated",
      "--evidence",
      "Bravo first, then Alpha"
    ]);
    expect(posts(calls)[0]!.body).toMatchObject({ basis: "stated", evidence: "Bravo first, then Alpha" });
  });

  it("refuses numbers that are not each of the group's once, before anything is sent", async () => {
    for (const bad of [
      ["1", "2", "3"],
      ["1", "1", "2", "3"],
      ["1", "2", "3", "5"],
      ["a", "b", "c", "d"]
    ]) {
      const { exitCode, stderr, calls } = await run([...bad, "--group", "g-1"]);
      expect(exitCode, bad.join(" ")).not.toBe(EXIT.ok);
      expect(stderr).toContain("Give all 4 numbers once, best first");
      expect(stderr).toContain("Nothing was changed");
      expect(posts(calls)).toEqual([]);
    }
    const mixed = await run(["1", "2", "3", "4", "--tie", "--group", "g-1"]);
    expect(mixed.exitCode).not.toBe(EXIT.ok);
    expect(mixed.stderr).toContain("not more than one");
  });

  it("refuses numbers or --tie without --group, explaining how, before reading or sending anything", async () => {
    for (const argv of [["3", "1", "4", "2"], ["--tie"]]) {
      const { exitCode, stderr, calls } = await run(argv);
      expect(exitCode, argv.join(" ")).toBe(EXIT.usage);
      expect(stderr).toContain("--group");
      expect(stderr).toContain("run `rhen rank` first");
      expect(stderr).toContain("groupId");
      expect(stderr).toContain("Nothing was changed");
      expect(stderr).toContain("rhen rank <numbers best first> --group <groupId>");
      expect(posts(calls)).toEqual([]);
      expect(calls.map((call) => call.path)).not.toContain(NEXT);
    }
  });

  it("still lets --skip and a plain look go without --group", async () => {
    const skip = await run(["--skip"]);
    expect(skip.exitCode).toBe(EXIT.ok);
    expect(posts(skip.calls)).toHaveLength(1);
    expect((await run([])).exitCode).toBe(EXIT.ok);
  });

  it("refuses to answer when --group is no longer the one waiting", async () => {
    const { exitCode, stderr, calls } = await run(["1", "2", "3", "4", "--group", "g-0"]);
    expect(exitCode).toBe(EXIT.conflict);
    expect(stderr).toContain("Group g-0 is no longer the one waiting; the next group is g-1");
    expect(posts(calls)).toEqual([]);
  });

  it("dry-run prints the answer and sends nothing", async () => {
    const { exitCode, stdout, calls } = await run(["2", "1", "3", "4", "--group", "g-1", "--dry-run", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: true,
      path: ANSWER,
      payload: { groupId: "g-1", rankedIds: ["p-b", "p-a", "p-c", "p-d"] }
    });
    expect(posts(calls)).toEqual([]);
  });

  it("shows the portal's refusal text, which names the next call", async () => {
    const message = 'Group g-1 was already answered. Nothing was changed. Next: rhen_inbox {"room":"compare"}';
    const { exitCode, stderr } = await run(["1", "2", "3", "4", "--group", "g-1"], {
      [ANSWER]: { status: 409, body: { error: message } }
    });
    expect(exitCode).toBe(EXIT.conflict);
    expect(stderr).toContain(message);
  });
});

describe("save comparison", () => {
  it("sends the group's answer to the same route, from fields", async () => {
    const { exitCode, calls } = await run(
      ["comparison", "--fields", '{"groupId":"g-1","rankedIds":["p-b","p-a","p-c","p-d"]}', "--basis", "inferred"],
      {},
      "save"
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)[0]).toMatchObject({
      path: ANSWER,
      body: { commandId: ID, groupId: "g-1", rankedIds: ["p-b", "p-a", "p-c", "p-d"], basis: "inferred" }
    });
  });

  it("takes a tie, and refuses a missing groupId naming the read that finds it", async () => {
    const tie = await run(["comparison", "--fields", '{"groupId":"g-1","tie":true}'], {}, "save");
    expect(posts(tie.calls)[0]!.body).toMatchObject({ groupId: "g-1", tie: true });
    const missing = await run(["comparison", "--fields", '{"rankedIds":["p-a","p-b"]}'], {}, "save");
    expect(missing.exitCode).not.toBe(EXIT.ok);
    expect(missing.stderr).toContain('rhen_inbox {"room":"compare"}');
    expect(missing.stderr).toContain('"entityType":"comparison"');
    expect(missing.stderr).toContain('"rankedIds"');
    expect(posts(missing.calls)).toEqual([]);
  });

  it("refuses a field the kind does not take, naming the ones it does", async () => {
    const { exitCode, stderr } = await run(["comparison", "--fields", '{"groupId":"g-1","order":[1,2]}'], {}, "save");
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("groupId, rankedIds, tie, wording");
  });

  it("spells out the whole call when the fields are malformed", async () => {
    const cases: [string, string][] = [
      ['{"groupId":"g-1","rankedIds":"p-a"}', "rankedIds must be a list"],
      ['{"groupId":"g-1","tie":"yes"}', "tie must be true or false"],
      ['{"groupId":"g-1","tie":true,"wording":5}', "wording must be"]
    ];
    for (const [fields, text] of cases) {
      const { exitCode, stderr, calls } = await run(["comparison", "--fields", fields], {}, "save");
      expect(exitCode, fields).not.toBe(EXIT.ok);
      expect(stderr).toContain(text);
      for (const part of ['"entityType":"comparison"', "groupId", "rankedIds", "tie", "wording", "basis", "evidence"])
        expect(stderr, `${fields}: ${part}`).toContain(part);
      expect(posts(calls)).toEqual([]);
    }
  });

  it("refuses --id and --expected-version, which a log entry has no use for", async () => {
    const { exitCode, stderr } = await run(
      ["comparison", "--fields", '{"groupId":"g-1","tie":true}', "--id", "x"],
      {},
      "save"
    );
    expect(exitCode).not.toBe(EXIT.ok);
    expect(stderr).toContain("an answer, not a record");
    expect(stderr).toContain('"entityType":"comparison"');
    expect(stderr).toContain("rankedIds");
  });
});

describe("inbox compare", () => {
  it("is listed only when named, and hands the group out with the exact answering call", async () => {
    const all = await run(["--json"], {}, "inbox");
    expect(all.calls.map((call) => call.path)).not.toContain(NEXT);
    const only = await run(["compare", "--json"], {}, "inbox");
    expect(only.exitCode).toBe(EXIT.ok);
    const rooms = JSON.parse(only.stdout);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ room: "compare", label: "Compare", count: 1 });
    expect(rooms[0].items[0]).toMatchObject({ id: "g-1", title: group.question });
    expect(rooms[0].items[0].data.group.items.map((item: { id: string }) => item.id)).toEqual([
      "p-a",
      "p-b",
      "p-c",
      "p-d"
    ]);
    expect(rooms[0].items[0].act).toContain("rank 1 2 3 4 --group g-1");
    expect(rooms[0].items[0].act).toContain("rank --tie --group g-1");
  });

  it("is empty, not an error, when nothing can be asked", async () => {
    const { exitCode, stdout } = await run(["compare", "--json"], { [NEXT]: { body: { group: null } } }, "inbox");
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout)[0]).toMatchObject({ room: "compare", count: 0, items: [] });
  });
});
