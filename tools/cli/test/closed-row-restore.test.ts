import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { restoreCallOf } from "../src/closed-rows.js";
import { memoryJournal } from "../src/undo-journal.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/** Hand-typed: entity, closed status, the tool its restore names (not read from the contracts). */
const CASES = [
  ["areas", "archived", "rhen_archive"],
  ["areas", "cancelled", "rhen_cancel"],
  ["outcomes", "archived", "rhen_archive"],
  ["outcomes", "cancelled", "rhen_cancel"],
  ["projects", "archived", "rhen_archive"],
  ["projects", "cancelled", "rhen_cancel"],
  ["actions", "archived", "rhen_archive"],
  ["actions", "cancelled", "rhen_cancel"],
  ["deliverables", "archived", "rhen_archive"],
  ["deliverables", "cancelled", "rhen_cancel"],
  ["commitments", "cancelled", "rhen_cancel"],
  ["routine-presets", "archived", "rhen_archive"],
  ["conditions", "archived", "rhen_archive"]
] as const;
const TYPE = {
  areas: "area",
  outcomes: "outcome",
  projects: "project",
  actions: "action",
  deliverables: "deliverable",
  commitments: "commitment",
  "routine-presets": "routine_preset",
  conditions: "condition_definition"
} as const;

describe("a closed row's restore call", () => {
  it.each(CASES)("%s %s carries %s with the row's own version", (entity, status, tool) => {
    expect(restoreCallOf(entity, { id: "r1", status, version: 7 })).toEqual({
      tool,
      arguments: { type: TYPE[entity], id: "r1", do: "restore", "expected-version": 7 }
    });
  });

  it("is absent for an open or finished row, a row with no version, and a kind that cannot be closed", () => {
    for (const status of ["active", "planned", "done", "completed", "confirmed", "in_progress"])
      expect(restoreCallOf("actions", { id: "r1", status, version: 2 }), status).toBeUndefined();
    expect(restoreCallOf("actions", { id: "r1", status: "cancelled" })).toBeUndefined();
    expect(restoreCallOf("captures", { id: "r1", status: "cancelled", version: 1 })).toBeUndefined();
    // A commitment is cancelled, never archived.
    expect(restoreCallOf("commitments", { id: "r1", status: "archived", version: 1 })).toBeUndefined();
  });
});

async function run(argv: string[]) {
  const raw = fixtureRawState();
  raw.commitments = (raw.commitments as Record<string, unknown>[]).map((row) => ({ ...row, version: 3 }));
  const out: string[] = [];
  await runCli(argv, {
    stdout: (text: string) => out.push(text),
    stderr: () => undefined,
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    journal: memoryJournal(),
    fetchImpl: fakeFetch({ "/api/state": { body: { state: raw } } }, [])
  });
  return out.join("\n");
}

describe("list and show", () => {
  it("list --json gives a closed row its restore call and an open row none", async () => {
    const rows = JSON.parse(await run(["list", "commitments", "--json"])) as Record<string, unknown>[];
    const cancelled = rows.find((row) => row.status === "cancelled")!;
    expect(cancelled.restore).toEqual({
      tool: "rhen_cancel",
      arguments: { type: "commitment", id: cancelled.id, do: "restore", "expected-version": 3 }
    });
    for (const row of rows.filter((candidate) => candidate.status === "confirmed"))
      expect(row).not.toHaveProperty("restore");
  });

  it("list keeps the restore call when --fields narrows the row", async () => {
    const rows = JSON.parse(await run(["list", "commitments", "--fields", "id,status", "--json"])) as Record<
      string,
      unknown
    >[];
    const cancelled = rows.find((row) => row.status === "cancelled")!;
    expect(cancelled).toHaveProperty("restore");
    expect(rows.find((row) => row.status === "confirmed")).not.toHaveProperty("restore");
  });

  it("list prints the call under a closed row in table mode", async () => {
    const text = await run(["list", "commitments"]);
    expect(text).toContain("rhen cancel commitment commitment-cancelled --restore");
  });

  it("show gives a closed record its restore call", async () => {
    const shown = JSON.parse(await run(["show", "commitment", "commitment-cancelled", "--json"])) as {
      restore: unknown;
      item: Record<string, unknown>;
    };
    expect(shown.restore).toMatchObject({ tool: "rhen_cancel", arguments: { do: "restore" } });
    const open = JSON.parse(await run(["show", "commitment", "commitment-dentist", "--json"])) as Record<
      string,
      unknown
    >;
    expect(open).not.toHaveProperty("restore");
  });
});
