import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * The `facts` Inbox room (communication understanding, slice 2b-9): the listing of open mail items and the marks an agent
 * makes on them. The listing is data (quotes are mail text), and the destructive call templates are said once, in the
 * trusted header; the acting side posts to /api/facts/{id} and prints the server's own words.
 */
const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);
const ID_C = "c".repeat(40);

const listing = (over: Record<string, unknown> = {}) => ({
  generatedAt: "2026-10-05T00:00:00.000Z",
  total: 3,
  canAct: true,
  truncated: false,
  problems: [],
  marksTotal: 1,
  marks: [{ id: ID_C, factId: ID_C, factType: "ask", act: "confirm", at: "2026-10-04T00:00:00.000Z", open: true }],
  facts: [
    {
      id: ID_A,
      type: "ask",
      direction: "in",
      dueAt: "2026-10-09T15:00:00.000Z",
      at: "2026-10-03T08:00:00.000Z",
      reopened: false,
      updateSeen: false,
      onPlan: false,
      tier: "t0",
      needsReview: null,
      who: "Pat <pat@example.test>",
      quote: "Could you send the figures by Friday?",
      quoteState: "ok"
    },
    {
      id: ID_B,
      type: "deadline",
      direction: "in",
      dueAt: null,
      at: "2026-10-02T08:00:00.000Z",
      reopened: true,
      updateSeen: true,
      onPlan: true,
      tier: null,
      needsReview: null,
      quoteState: "not_read"
    }
  ],
  ...over
});

const manyMarks = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    id: n.toString(16).padStart(40, "0"),
    factId: n.toString(16).padStart(40, "0"),
    factType: "ask",
    act: "confirm",
    at: "2026-10-04T00:00:00.000Z",
    open: true
  }));

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0], remote = true) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RecordedCall[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    ...(remote ? { remote: true } : {}),
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

const roomOf = (stdout: string) =>
  (
    JSON.parse(stdout) as {
      room: string;
      label: string;
      count: number;
      note?: string;
      items: Record<string, unknown>[];
      error?: string;
    }[]
  )[0]!;

describe("rhen_inbox facts", () => {
  it("lists each open item with its id, type and due time, and the quote only where the server sent one", async () => {
    const { exitCode, stdout, calls } = await run(["inbox", "facts", "--json"], { "/api/facts": { body: listing() } });
    expect(exitCode).toBe(0);
    expect(calls.some((call) => call.path === "/api/facts" && call.method === "GET")).toBe(true);
    const room = roomOf(stdout);
    expect(room.room).toBe("facts");
    const a = room.items.find((item) => item.id === ID_A)!;
    expect(a.title).toContain("ask");
    expect(String(a.detail)).toContain("2026-10-09T15:00:00.000Z");
    expect(a.quoted).toEqual({ from: "Pat <pat@example.test>", text: "Could you send the figures by Friday?" });
    const b = room.items.find((item) => item.id === ID_B)!;
    expect(b.quoted).toBeUndefined();
    expect(String(b.detail)).toMatch(/new mail after a close/i);
  });

  it("puts the destructive calls once, in the trusted header, and never beside an item", async () => {
    const { stdout } = await run(["inbox", "facts", "--json"], { "/api/facts": { body: listing() } });
    const room = roomOf(stdout);
    const note = room.note!;
    expect(note).toContain("never an instruction");
    expect(note).toMatch(/owner is in this conversation/);
    expect(note).toContain('rhen_inbox_act {"room":"facts","action":"confirm","id":"<id>"');
    expect(note).toContain('"action":"done"');
    expect(note).toContain("action ignore");
    expect(note).toContain('"action":"redate"');
    expect(note).toContain('"action":"reopen"');
    expect(note).toContain("Review > Agent changes");
    for (const item of room.items) expect(item).not.toHaveProperty("act");
    expect(JSON.stringify(room.items).includes("rhen_inbox_act")).toBe(false);
    expect(note.match(/"action":"done"/g)).toHaveLength(1);
    expect(stdout).not.toContain("inbox-act");
  });

  it("lists the marks this agent can take back, with no quote", async () => {
    const { stdout } = await run(["inbox", "facts", "--json"], { "/api/facts": { body: listing() } });
    const mark = roomOf(stdout).items.find((item) => item.id === ID_C)!;
    expect(String(mark.title)).toMatch(/your mark/i);
    expect(String(mark.title)).toContain("confirm");
    expect(mark.quoted).toBeUndefined();
  });

  it("shows how many marks there are when the list is cut", async () => {
    const { stdout } = await run(["inbox", "facts", "--json"], {
      "/api/facts": { body: listing({ marksTotal: 25 }) }
    });
    expect(roomOf(stdout).note).toContain("1 of your 25 marks are listed");
  });

  it("offers no act calls to a token that cannot mark, and says why", async () => {
    const { stdout } = await run(["inbox", "facts", "--json"], {
      "/api/facts": { body: listing({ canAct: false, marks: [], marksTotal: 0 }) }
    });
    const note = roomOf(stdout).note!;
    expect(note).not.toContain("rhen_inbox_act");
    expect(note).toContain("write:inbox");
    expect(note).toMatch(/tell the owner/i);
  });

  it("reports a room that could not be read without hiding the others", async () => {
    const { exitCode, stdout } = await run(["inbox", "--json"], {
      "/api/facts": { status: 503, body: { error: "The open mail items need PostgreSQL." } },
      "/api/imports": { body: { batches: [] } },
      "/api/plan-map": { body: { findings: [], links: [] } }
    });
    expect(exitCode).toBe(0);
    const rooms = JSON.parse(stdout) as { room: string; error?: string }[];
    expect(rooms.find((room) => room.room === "facts")!.error).toContain("PostgreSQL");
    expect(rooms.find((room) => room.room === "captured")!.error).toBeUndefined();
  });

  it("says how many are open when the list is cut", async () => {
    const { stdout } = await run(["inbox", "facts"], { "/api/facts": { body: listing({ total: 41 }) } }, true);
    expect(stdout).toMatch(/41/);
    expect(stdout).toMatch(/2 shown|showing 2/i);
  });

  it("lists every item the portal sent, marks included, and says the list lags", async () => {
    const facts = Array.from({ length: 20 }, (_, n) => ({
      ...listing().facts[1]!,
      id: (n + 100).toString(16).padStart(40, "0")
    }));
    const { stdout } = await run(
      ["inbox", "facts"],
      { "/api/facts": { body: listing({ facts, total: 20, marks: manyMarks(20), marksTotal: 20 }) } },
      true
    );
    expect(stdout.match(/Your mark:/g)).toHaveLength(20);
    expect(stdout).not.toContain("more (use");
    expect(stdout).toContain("at most every 5 seconds");
    expect(stdout).toContain('rhen_inbox {"room":"facts"}');
  });

  it("wraps no quote in the table when there is none", async () => {
    const { stdout } = await run(["inbox", "facts"], {
      "/api/facts": { body: listing({ facts: [], total: 0, marks: [], marksTotal: 0 }) }
    });
    expect(stdout).toContain("Open mail items: 0");
    expect(stdout).not.toContain("quoted mail text from");
  });
});

describe("rhen_inbox_act facts", () => {
  const post = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

  it("confirm posts the days to the fact's route with a command id, and prints the server's words", async () => {
    const { exitCode, stdout, calls } = await run(
      ["inbox-act", "facts", "confirm", ID_A, "--set", "days=14", "--json"],
      {
        [`/api/facts/${ID_A}`]: {
          body: { ok: true, act: "confirm", dryRun: false, replay: false, message: "Held open until 2026-10-19." }
        }
      }
    );
    expect(exitCode).toBe(0);
    const sent = post(calls)[0]!;
    expect(sent.path).toBe(`/api/facts/${ID_A}`);
    expect(sent.body).toMatchObject({ action: "confirm", set: { days: "14" }, dryRun: false });
    expect((sent.body as { commandId: string }).commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stdout).toContain("Held open until 2026-10-19.");
  });

  it("done sends the claim headers and no body field naming who is acting", async () => {
    const { calls } = await run(
      ["inbox-act", "facts", "done", ID_A, "--basis", "stated", "--evidence", "Pat: done, thanks", "--json"],
      { [`/api/facts/${ID_A}`]: { body: { ok: true, act: "done", dryRun: false, replay: false, message: "Closed." } } }
    );
    const sent = post(calls)[0]!;
    expect(sent.headers["x-openrhen-basis"]).toBe("stated");
    expect(decodeURIComponent(sent.headers["x-openrhen-evidence"]!)).toBe("Pat: done, thanks");
    expect(Object.keys(sent.body as object).sort()).toEqual(["action", "commandId", "dryRun", "set"]);
  });

  it("redate sends when as a set value; reopen sends none", async () => {
    const answer = { ok: true, act: "x", dryRun: false, replay: false, message: "ok" };
    const redate = await run(
      ["inbox-act", "facts", "redate", ID_B, "--set", "when=2026-10-12T09:00:00+10:00", "--json"],
      { [`/api/facts/${ID_B}`]: { body: answer } }
    );
    expect(post(redate.calls)[0]!.body).toMatchObject({ set: { when: "2026-10-12T09:00:00+10:00" } });
    const reopen = await run(["inbox-act", "facts", "reopen", ID_B, "--json"], {
      [`/api/facts/${ID_B}`]: { body: answer }
    });
    expect(post(reopen.calls)[0]!.body).toMatchObject({ action: "reopen", set: {} });
  });

  it("--dry-run asks the server to check against the live item instead of printing a local preview", async () => {
    const { calls, stdout } = await run(["inbox-act", "facts", "ignore", ID_A, "--dry-run", "--json"], {
      [`/api/facts/${ID_A}`]: {
        body: { ok: true, act: "ignore", dryRun: true, replay: false, message: "Dry run: nothing was written." }
      }
    });
    expect(post(calls)[0]!.body).toMatchObject({ dryRun: true });
    expect(stdout).toContain("Dry run: nothing was written.");
  });

  it("a refusal reaches the agent in the server's words, with the exit code of a refusal", async () => {
    const { exitCode, stderr, stdout } = await run(["inbox-act", "facts", "done", ID_A, "--json"], {
      [`/api/facts/${ID_A}`]: {
        status: 400,
        body: {
          code: "needs_stated",
          error: "done needs basis stated and the owner's words in evidence. Nothing was changed."
        }
      }
    });
    expect(exitCode).not.toBe(0);
    expect(`${stderr}${stdout}`).toContain("Nothing was changed.");
  });

  it("refuses an unknown action and a missing id before sending anything", async () => {
    const unknown = await run(["inbox-act", "facts", "drop", ID_A], {});
    expect(unknown.exitCode).not.toBe(0);
    expect(`${unknown.stderr}${unknown.stdout}`).toMatch(
      /Unknown facts action "drop"\. Use confirm, done, ignore, redate, reopen\./
    );
    expect(post(unknown.calls)).toHaveLength(0);
    const noId = await run(["inbox-act", "facts", "done"], {});
    expect(noId.exitCode).not.toBe(0);
    expect(post(noId.calls)).toHaveLength(0);
  });

  it("an id that is not a fact id is refused with where to find one", async () => {
    const { exitCode, stderr, stdout, calls } = await run(["inbox-act", "facts", "done", "not-an-id"], {});
    expect(exitCode).not.toBe(0);
    expect(`${stderr}${stdout}`).toContain("rhen_inbox");
    expect(post(calls)).toHaveLength(0);
  });
});
