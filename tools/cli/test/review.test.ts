import { confirmProjectWantedCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { memoryJournal } from "../src/undo-journal.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/** A portal whose Thesis project is at version 4, already kept once when `reviewed` is given. */
function portal(reviewed?: string) {
  const raw = fixtureRawState();
  raw.projects = (raw.projects as Record<string, unknown>[]).map((project) =>
    project.id === "project-thesis"
      ? { ...project, version: 4, ...(reviewed ? { lastReviewedAt: reviewed } : {}) }
      : project
  );
  return raw;
}

async function run(argv: string[], raw = portal(), journal = memoryJournal()) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(["review", ...argv], {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal,
    fetchImpl: fakeFetch(
      { "/api/state": { body: { state: raw } }, "/api/commands/project-review": { body: { state: raw } } },
      calls
    )
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls, journal };
}

const posts = (calls: RecordedCall[]) => calls.filter((call) => call.method === "POST");

describe("review keep", () => {
  it("sends the confirm command for a project found by title, at the version it read", async () => {
    const { exitCode, calls } = await run(["keep", "thesis", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const [post] = posts(calls);
    expect(post?.url).toContain("/api/commands/project-review");
    const parsed = confirmProjectWantedCommandSchema.parse(post?.body);
    expect(parsed).toMatchObject({ projectId: "project-thesis", expectedVersion: 4 });
    expect(parsed.reviewedAt).toBeUndefined();
  });

  it("journals an undo that restores the earlier review time, or none", async () => {
    const first = await run(["keep", "project-thesis"]);
    const [fresh] = first.journal.read();
    expect(fresh?.undo.path).toBe("/api/commands/project-review");
    expect(fresh?.undo.payload).toMatchObject({ projectId: "project-thesis", expectedVersion: 5, reviewedAt: null });
    expect(fresh?.target).toEqual({ stateKey: "projects", id: "project-thesis" });

    const again = await run(["keep", "project-thesis"], portal("2026-10-01T00:00:00.000Z"));
    expect(again.journal.read()[0]?.undo.payload).toMatchObject({ reviewedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("marks an overdue project seen with --kind, and journals an undo for that stamp", async () => {
    const raw = portal();
    raw.projects = (raw.projects as Record<string, unknown>[]).map((project) =>
      project.id === "project-thesis" ? { ...project, overdueSeenAt: "2026-10-20T00:00:00.000Z" } : project
    );
    const { exitCode, calls, journal } = await run(["keep", "thesis", "--kind", "overdue_seen"], raw);
    expect(exitCode).toBe(EXIT.ok);
    const parsed = confirmProjectWantedCommandSchema.parse(posts(calls)[0]?.body);
    expect(parsed).toMatchObject({ projectId: "project-thesis", expectedVersion: 4, kind: "overdue_seen" });
    expect(journal.read()[0]?.undo.payload).toMatchObject({
      kind: "overdue_seen",
      expectedVersion: 5,
      reviewedAt: "2026-10-20T00:00:00.000Z"
    });
  });

  it("refuses an unknown kind", async () => {
    const { exitCode, calls } = await run(["keep", "thesis", "--kind", "bogus"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends nothing on --dry-run", async () => {
    const { exitCode, calls, stdout } = await run(["keep", "Thesis", "--dry-run"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(posts(calls)).toHaveLength(0);
    expect(stdout).toContain("project-review");
  });

  it("refuses an unknown project and an unknown subcommand", async () => {
    expect((await run(["keep", "Nope"])).exitCode).toBe(EXIT.notFound);
    expect((await run(["drop", "Thesis"])).exitCode).toBe(EXIT.usage);
    expect((await run(["keep"])).exitCode).toBe(EXIT.usage);
  });
});
