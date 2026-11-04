import { planningEntityCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { CommandSpec } from "../src/command.js";
import { buildLineContext, handleLine, parseWriteScope, toolName } from "../src/commands/mcp.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(
      { "/api/state": { body: { state: rawState } }, "/api/check-ins/current": { body: { checkIn: null } }, ...routes },
      calls
    )
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

describe("capture", () => {
  it("files one pending capture through the entity route", async () => {
    let posted: Record<string, unknown> | undefined;
    const raw = fixtureRawState();
    const { exitCode, stdout } = await run(["capture", "Ring the plumber", "--json"], {
      "/api/commands/entity": (call) => {
        posted = call.body as Record<string, unknown>;
        expect(planningEntityCommandSchema.safeParse(call.body).success).toBe(true);
        const entity = posted.entity as Record<string, unknown>;
        return {
          body: { state: { ...raw, captures: [...(raw.captures as unknown[]), { id: "capture-new", ...entity }] } }
        };
      }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.entityType).toBe("capture");
    expect(posted?.expectedVersion).toBeNull();
    expect(posted?.entity).toEqual({ text: "Ring the plumber", status: "pending" });
    expect((JSON.parse(stdout) as { id: string }).id).toBe("capture-new");
  });

  it("keeps every word of an unquoted capture", async () => {
    const { exitCode, stdout } = await run(["capture", "Buy", "milk", "and", "eggs", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(stdout) as { payload: { entity: { text: string } } };
    expect(printed.payload.entity.text).toBe("Buy milk and eggs");
  });

  it("stores a resolved area id as a review hint", async () => {
    const { exitCode, stdout } = await run(["capture", "Fix the gate", "--area", "Home", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    const printed = JSON.parse(stdout) as { payload: { entity: { proposedFields: Record<string, unknown> } } };
    expect(printed.payload.entity.proposedFields).toEqual({ text: "Fix the gate", areaId: "area-home" });
  });

  it("refuses an unknown area and sends nothing", async () => {
    const { exitCode, calls } = await run(["capture", "Fix the gate", "--area", "Nowhere"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses empty text", async () => {
    const { exitCode } = await run(["capture", "   "]);
    expect(exitCode).toBe(EXIT.usage);
  });
});

describe("search", () => {
  const answer = {
    ranking: "hybrid",
    total: 2,
    results: [
      {
        kind: "commitment",
        id: "commitment-dentist",
        title: "Dentist",
        status: "confirmed",
        path: "",
        matched: "both",
        fields: ["title"],
        score: 0.03
      }
    ]
  };

  it("asks the portal's plan search and passes every option through", async () => {
    const { exitCode, stdout, calls } = await run(
      [
        "search",
        "dentist",
        "--kinds",
        "commitments,captures",
        "--under",
        "Health",
        "--status",
        "any",
        "--limit",
        "1",
        "--json"
      ],
      { "/api/plan/search": { body: answer } }
    );
    expect(exitCode).toBe(EXIT.ok);
    const call = calls.find((c) => c.path === "/api/plan/search")!;
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({
      q: "dentist",
      kinds: "commitments,captures",
      under: "Health",
      status: "any",
      mode: "hybrid",
      limit: "1"
    });
    expect(calls.some((c) => c.path === "/api/state")).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ ...answer, shown: 1 });
  });

  it("keeps the source the portal names on an outside hit, and drops it on the person's own", async () => {
    const { stdout, calls } = await run(["search", "dentist", "--json"], {
      "/api/plan/search": {
        body: {
          ...answer,
          results: [
            { ...answer.results[0], id: "commitment-invite", sourceType: "example_shared" },
            { ...answer.results[0], id: "capture-mine", kind: "capture", sourceType: "manual_capture" }
          ]
        }
      }
    });
    expect(calls.some((c) => c.path === "/api/state")).toBe(false);
    const hits = (JSON.parse(stdout) as { results: { id: string; sourceType?: string }[] }).results;
    expect(hits.find((hit) => hit.id === "commitment-invite")?.sourceType).toBe("example_shared");
    expect("sourceType" in hits.find((hit) => hit.id === "capture-mine")!).toBe(false);
  });

  it("takes --like without a query and keeps --entity as an alias of --kinds", async () => {
    const { exitCode, calls } = await run(["search", "--like", "action-cite", "--entity", "actions", "--json"], {
      "/api/plan/search": { body: { ranking: "hybrid", total: 0, results: [] } }
    });
    expect(exitCode).toBe(EXIT.ok);
    const params = new URL(calls.find((c) => c.path === "/api/plan/search")!.url).searchParams;
    expect(params.get("like")).toBe("action-cite");
    expect(params.get("kinds")).toBe("actions");
    expect(params.has("q")).toBe(false);
  });

  it("says in the table view when meaning was unavailable", async () => {
    const { stderr } = await run(["search", "dentist"], {
      "/api/plan/search": { body: { ...answer, ranking: "words", note: "Ranked by words only: proxy down." } }
    });
    expect(stderr).toContain("Ranked by words only: proxy down.");
  });

  it("falls back to words over the state when the portal has no plan search", async () => {
    const { exitCode, stdout } = await run(["search", "dentist", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const result = JSON.parse(stdout) as { ranking: string; note: string; total: number; results: { kind: string }[] };
    expect(result.ranking).toBe("words");
    expect(result.note).toMatch(/no search by meaning/);
    const kinds = result.results.map((hit) => hit.kind);
    expect(kinds).toContain("commitment");
    expect(kinds).toContain("capture");
    const capped = await run(["search", "e", "--limit", "1", "--json"]);
    const parsed = JSON.parse(capped.stdout) as { total: number; shown: number };
    expect(parsed.shown).toBe(1);
    expect(parsed.total).toBeGreaterThan(1);
  });

  it("refuses what it cannot answer", async () => {
    expect((await run(["search", "x", "--entity", "nonsense"])).exitCode).toBe(EXIT.usage);
    expect((await run(["search", "x", "--mode", "fuzzy"])).exitCode).toBe(EXIT.usage);
    expect((await run(["search"])).exitCode).toBe(EXIT.usage);
    expect((await run(["search", "--like", "a"])).exitCode).toBe(EXIT.unavailable);
  });
});

describe("status and outside commitments", () => {
  it("lists the calendar-sourced commitments it shows by title only", async () => {
    const raw = fixtureRawState();
    raw.commitments = (raw.commitments as Record<string, unknown>[]).map((commitment) =>
      commitment.id === "commitment-gym" ? { ...commitment, sourceType: "google_calendar" } : commitment
    );
    const { stdout } = await run(["status", "--json"], {}, raw);
    const status = JSON.parse(stdout) as { outsideText?: { commitmentIds: string[] } };
    expect(status.outsideText?.commitmentIds).toContain("commitment-gym");
    const plain = JSON.parse((await run(["status", "--json"])).stdout) as Record<string, unknown>;
    expect("outsideText" in plain).toBe(false);
  });
});

describe("status --brief", () => {
  it("is a compact digest and does not read the check-in", async () => {
    const { exitCode, stdout, calls } = await run(["status", "--brief", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.path === "/api/check-ins/current")).toBe(false);
    const brief = JSON.parse(stdout) as {
      next: { title: string }[];
      minutesUntilSleep: number | null;
      deadlinesWithin48h: { id: string; overdue: boolean }[];
      inboxPending: number;
    };
    expect(brief.next.length).toBeGreaterThan(0);
    expect(brief.next.length).toBeLessThanOrEqual(3);
    expect(brief.next[0]?.title).toBe("Draft chapter 3");
    expect(brief.minutesUntilSleep).toBe(13 * 60);
    expect(brief.inboxPending).toBeGreaterThanOrEqual(1);
    // Nothing in the fixture is due within 48 hours of its fixed "now"; past-due open work shows as overdue.
    expect(brief.deadlinesWithin48h.every((item) => item.overdue)).toBe(true);
  });

  it("lists open work due soon, soonest first, and leaves closed work out", async () => {
    const raw = fixtureRawState();
    const actions = raw.actions as Record<string, unknown>[];
    raw.actions = actions.map((action, index) =>
      index === 0
        ? { ...action, deadlineAt: "2026-09-04T09:00:00+10:00", status: "planned" }
        : index === 1
          ? { ...action, deadlineAt: "2026-09-03T12:00:00+10:00", status: "done" }
          : action
    );
    const { stdout } = await run(["status", "--brief", "--json"], {}, raw);
    const brief = JSON.parse(stdout) as { deadlinesWithin48h: { id: string; overdue: boolean }[] };
    const ids = brief.deadlinesWithin48h.map((item) => item.id);
    expect(ids).toContain(String(actions[0]?.id));
    expect(ids).not.toContain(String(actions[1]?.id));
  });

  it("renders a short table", async () => {
    const { stdout } = await run(["status", "--brief"]);
    expect(stdout).toContain("Next");
    expect(stdout).toContain("Inbox");
  });
});

describe("recurrence set --dry-run preview", () => {
  it("shows the changed fields and how many future occurrences it would rewrite, without --yes", async () => {
    const raw = fixtureRawState();
    raw.commitmentRecurrenceRules = (raw.commitmentRecurrenceRules as Record<string, unknown>[]).map((rule) =>
      rule.id === "rule-gym" ? { ...rule, repeat: { unit: "days", intervalDays: 7 } } : rule
    );
    const { exitCode, stdout, calls } = await run(
      ["recurrence", "set", "--id", "rule-gym", "--set", "title=Gym v3", "--dry-run"],
      {},
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(stdout) as {
      preview: { creates: boolean; changedFields: Record<string, { to: unknown }>; futureOccurrencesAffected: number };
    };
    expect(printed.preview.creates).toBe(false);
    expect(printed.preview.changedFields.title?.to).toBe("Gym v3");
    expect(printed.preview.futureOccurrencesAffected).toBe(1);
  });
});

describe("mcp write scope", () => {
  const call = (name: string) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = async (options: Parameters<typeof buildLineContext>[0]) => {
    const ctx = await buildLineContext(options);
    const response = JSON.parse((await handleLine(list, ctx)) ?? "{}") as { result: { tools: { name: string }[] } };
    return response.result.tools.map((tool) => tool.name);
  };

  it("--allow-writes keeps every read tool and only the named write tools", async () => {
    const tools = await names({ allowWrites: ["capture", "session"] });
    expect(tools).toContain("rhen_capture");
    expect(tools).toContain("rhen_session");
    expect(tools).toContain("rhen_status");
    expect(tools).toContain("rhen_search");
    expect(tools).not.toContain("rhen_bulk");
    expect(tools).not.toContain("rhen_recurrence");
    expect(tools).not.toContain("rhen_save");
  });

  it("--deny-writes hides just the named write tools", async () => {
    const tools = await names({ denyWrites: ["bulk", "recurrence"] });
    expect(tools).not.toContain("rhen_bulk");
    expect(tools).not.toContain("rhen_recurrence");
    expect(tools).toContain("rhen_save");
  });

  it("never hides rhen_reenter, the one call a lapsed agent may make, whatever the write scope", async () => {
    expect(await names({ denyWrites: ["reenter", "bulk"] })).toContain("rhen_reenter");
    const scoped = await names({ allowWrites: ["capture"] });
    expect(scoped).toContain("rhen_reenter");
    expect(scoped).not.toContain("rhen_bulk");
  });

  it("refuses an out-of-scope tool called by name, without running it", async () => {
    let ran = false;
    const ctx = await buildLineContext({
      allowWrites: ["capture"],
      runner: async () => {
        ran = true;
        return 0;
      }
    });
    const response = JSON.parse((await handleLine(call("rhen_bulk"), ctx)) ?? "{}") as {
      result?: { isError: boolean; structuredContent: { error: { code: string; message: string } } };
    };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent.error.code).toBe("scope");
    expect(response.result?.structuredContent.error.message).toContain("write scope");
    expect(ran).toBe(false);
  });

  it("accepts tool-style names and rejects a typo", async () => {
    expect(
      await parseWriteScope(`${toolName({ name: "check_in" } as CommandSpec)}, capture`, "--allow-writes")
    ).toEqual(["check-in", "capture"]);
    await expect(parseWriteScope("captrue", "--allow-writes")).rejects.toThrow(/unknown write tool captrue/);
    await expect(parseWriteScope("status", "--deny-writes")).rejects.toThrow(/unknown write tool status/);
  });
});
