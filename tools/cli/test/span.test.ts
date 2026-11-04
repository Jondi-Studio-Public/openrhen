import { planningEntityCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

const TRIP = { id: "span-trip", version: 2, title: "Trip 1", startDate: "2026-08-27", endDate: "2026-08-29" };

function rawWithSpans(spans: unknown[] = [TRIP]): Record<string, unknown> {
  return { ...fixtureRawState(), spans };
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = rawWithSpans()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls);
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

describe("span add", () => {
  it("sends a save_entity span with a new id and a null expected version", async () => {
    const { exitCode, calls } = await run(
      ["span", "add", "--title", "Trip 2", "--start", "2026-09-10", "--end", "2026-09-12", "--json"],
      { "/api/commands/entity": () => ({ body: { state: rawWithSpans() } }) }
    );
    expect(exitCode).toBe(EXIT.ok);
    const body = posts(calls)[0]!.body as Record<string, unknown>;
    expect(planningEntityCommandSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      type: "save_entity",
      entityType: "span",
      expectedVersion: null,
      entity: { title: "Trip 2", startDate: "2026-09-10", endDate: "2026-09-12" }
    });
    expect((body.entity as Record<string, unknown>).id).toBe(body.commandId);
  });

  it("makes a one-day span from a start alone and carries a window and a resolved project", async () => {
    const { calls, exitCode } = await run([
      "span",
      "add",
      "--title",
      "Conference",
      "--start",
      "2026-09-10",
      "--window",
      "09:00-17:00",
      "--project",
      "Thesis",
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
    const out = calls; // dry run prints, never posts
    expect(out.every((call) => call.method === "GET")).toBe(true);
  });

  it("dry run prints the payload and sends nothing", async () => {
    const { stdout, calls, exitCode } = await run([
      "span",
      "add",
      "--title",
      "Conference",
      "--start",
      "2026-09-10",
      "--window",
      "09:00-17:00",
      "--project",
      "Thesis",
      "--dry-run"
    ]);
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
    const printed = JSON.parse(stdout) as { dryRun: boolean; payload: { entity: Record<string, unknown> } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.entity).toMatchObject({
      title: "Conference",
      startDate: "2026-09-10",
      endDate: "2026-09-10",
      window: { localStartTime: "09:00", localEndTime: "17:00" },
      projectId: "project-thesis"
    });
  });

  it("refuses invalid dates, end before start and a bad window before sending", async () => {
    for (const argv of [
      ["--title", "x", "--start", "2026-09-31"],
      ["--title", "x", "--start", "2026-13-01"],
      ["--title", "x", "--start", "10/09/2026"],
      ["--title", "x", "--start", "2026-09-10", "--end", "2026-09-09"],
      ["--title", "x", "--start", "2026-09-10", "--window", "17:00-09:00"],
      ["--title", "x", "--start", "2026-09-10", "--window", "wake+30"]
    ]) {
      const { exitCode, calls } = await run(["span", "add", ...argv]);
      expect([EXIT.usage, EXIT.validation]).toContain(exitCode);
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it("needs a title and a start", async () => {
    const { exitCode, stderr } = await run(["span", "add", "--title", "x"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("--title and --start");
  });
});

describe("span set and remove", () => {
  it("changes only the given fields and sends the stored version", async () => {
    const { exitCode, calls } = await run(["span", "set", "Trip 1", "--end", "2026-08-30", "--json"], {
      "/api/commands/entity": () => ({ body: { state: rawWithSpans() } })
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)[0]!.body).toMatchObject({
      expectedVersion: 2,
      entityType: "span",
      entity: { id: "span-trip", title: "Trip 1", startDate: "2026-08-27", endDate: "2026-08-30" }
    });
  });

  it("clears a window and refuses a set with nothing to change or a missing span", async () => {
    const withWindow = rawWithSpans([{ ...TRIP, window: { localStartTime: "09:00", localEndTime: "10:00" } }]);
    const cleared = await run(["span", "set", "span-trip", "--window", "none", "--dry-run"], {}, withWindow);
    const entity = (JSON.parse(cleared.stdout) as { payload: { entity: Record<string, unknown> } }).payload.entity;
    expect(entity.window).toBeUndefined();
    expect((await run(["span", "set", "Trip 1"])).exitCode).toBe(EXIT.usage);
    expect((await run(["span", "set", "Nope", "--end", "2026-09-01"])).exitCode).toBe(EXIT.notFound);
  });

  it("removes by id or title with remove: true", async () => {
    const { exitCode, calls, stdout } = await run(["span", "remove", "span-trip", "--json"], {
      "/api/commands/entity": () => ({ body: { state: rawWithSpans([]) } })
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)[0]!.body).toMatchObject({
      expectedVersion: 2,
      entityType: "span",
      entity: { id: "span-trip", remove: true }
    });
    expect(JSON.parse(stdout)).toEqual({ ok: true, removed: "span-trip" });
  });
});

describe("span list and the generic readers", () => {
  it("lists spans overlapping a range", async () => {
    const inside = await run(["span", "list", "--from", "2026-08-29", "--to", "2026-09-05", "--json"]);
    expect(JSON.parse(inside.stdout)).toHaveLength(1);
    const outside = await run(["span", "list", "--from", "2026-09-01", "--json"]);
    expect(JSON.parse(outside.stdout)).toHaveLength(0);
    expect(posts(inside.calls)).toHaveLength(0);
  });

  it("is available as list spans and show span, which work under --read-only", async () => {
    const list = await run(["list", "spans", "--read-only", "--json"]);
    expect(list.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(list.stdout)).toHaveLength(1);
    const show = await run(["show", "span", "span-trip", "--read-only", "--json"]);
    expect(show.exitCode).toBe(EXIT.ok);
  });

  it("is refused by span itself under --read-only", async () => {
    const { exitCode, calls } = await run(["span", "add", "--title", "x", "--start", "2026-09-10", "--read-only"]);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
  });
});

describe("save span", () => {
  it("validates dates through the shared span schema", async () => {
    const bad = await run([
      "save",
      "span",
      "--set",
      "title=x",
      "--set",
      "startDate=2026-09-10",
      "--set",
      "endDate=2026-09-01"
    ]);
    expect(bad.exitCode).toBe(EXIT.validation);
    const removed = await run(["save", "span", "--id", "span-trip", "--set", "remove=true", "--dry-run"]);
    expect(removed.exitCode).toBe(EXIT.ok);
  });
});
