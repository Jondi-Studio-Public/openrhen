import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { entityCatalogue, entityItems } from "../src/entities.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface RunResult {
  exitCode: number;
  lines: string[];
  text: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(argv: string[], state: Record<string, unknown> = fixtureRawState()): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const exitCode = await runCli(["list", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += (stderr ? "\n" : "") + text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } } }, calls)
  });
  return { exitCode, lines, text: lines.join("\n"), stderr, calls };
}

function ids(rows: unknown[]): string[] {
  return rows.map((row) => (row as { id: string }).id);
}

/** commitment-gym pinned directly to the fixture's preset-gym, for exercising `--preset`. */
function withGymPinnedToPreset(): Record<string, unknown> {
  const state = fixtureRawState();
  const commitments = state.commitments as Record<string, unknown>[];
  state.commitments = commitments.map((commitment) =>
    commitment.id === "commitment-gym"
      ? { ...commitment, routineSource: "preset", routinePresetId: "preset-gym" }
      : commitment
  );
  return state;
}

describe("list", () => {
  it("counts the fields an action lists as assumed in the table and names them in --json", async () => {
    const state = fixtureRawState();
    state.actions = (state.actions as Record<string, unknown>[]).map((item) =>
      item.id === "action-draft" ? { ...item, assumedFields: ["expectedMinutes", "energy"] } : item
    );
    const table = await run(["actions", "--project", "project-thesis"], state);
    const [header, , ...rows] = table.text.split("\n");
    const column = header!.indexOf("assumedFields.length");
    expect(column).toBeGreaterThan(-1);
    const cell = (id: string) =>
      rows
        .find((row) => row.startsWith(id))!
        .slice(column)
        .trim();
    expect(cell("action-draft")).toBe("2");
    expect(cell("action-cite")).toBe("");
    const json = await run(["actions", "--project", "project-thesis", "--json"], state);
    const draft = (JSON.parse(json.text) as { id: string; assumedFields?: string[] }[]).find(
      (row) => row.id === "action-draft"
    );
    expect(draft?.assumedFields).toEqual(["expectedMinutes", "energy"]);
  });

  it("refuses an unknown entity", async () => {
    const result = await run(["widgets"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown entity "widgets"');
  });

  // `save` has always accepted "place"/"condition-definition" alongside "places"/"condition-definitions"
  // (ENTITY_TYPES in save.ts); `findEntity` (entities.ts), shared by `show` and `list`, was missing the
  // two singular forms, so `save place …` worked but `list place` refused the entity outright.
  it('accepts the singular "place" and "condition-definition" aliases, same as save', async () => {
    const byPlace = await run(["place", "--json"]);
    expect(byPlace.exitCode).toBe(EXIT.ok);
    expect(ids(JSON.parse(byPlace.text) as unknown[])).toContain("ctx-home");

    const byConditionDefinition = await run(["condition-definition", "--json"]);
    expect(byConditionDefinition.exitCode).toBe(EXIT.ok);
    expect(ids(JSON.parse(byConditionDefinition.text) as unknown[])).toContain("ctx-home");
  });

  it("refuses a filter that does not apply, naming the ones that do", async () => {
    const result = await run(["areas", "--project", "Study"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--project does not apply to areas");
    expect(result.stderr).toContain("--status");
    expect(result.stderr).toContain("--search");
  });

  it("reports notFound when a reference filter names something that doesn't exist", async () => {
    const result = await run(["actions", "--project", "nope"]);
    expect(result.exitCode).toBe(EXIT.notFound);
  });

  it("matches --project by id or by exact title", async () => {
    const byTitle = await run(["actions", "--project", "Thesis", "--json"]);
    const byId = await run(["actions", "--project", "project-thesis", "--json"]);
    const wanted = ["action-draft", "action-cite", "action-done"];
    expect(ids(JSON.parse(byTitle.text)).sort()).toEqual([...wanted].sort());
    expect(ids(JSON.parse(byId.text)).sort()).toEqual([...wanted].sort());
    expect(byTitle.calls.every((call) => call.method === "GET" && call.path === "/api/state")).toBe(true);
  });

  it("filters projects by --area, matching the project's own area", async () => {
    const result = await run(["projects", "--area", "Study", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["project-thesis"]);
  });

  it("filters actions by --area, through their project", async () => {
    const result = await run(["actions", "--area", "Home", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["action-weed"]);
  });

  it("filters projects by --outcome", async () => {
    const result = await run(["projects", "--outcome", "Finish the degree", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["project-thesis"]);
  });

  it("filters occurrences by --action", async () => {
    const result = await run(["occurrences", "--action", "Weed the beds", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["occurrence-weed"]);
  });

  it("filters routine-steps by --commitment", async () => {
    const result = await run(["routine-steps", "--commitment", "Gym session", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["step-pack", "step-shower"].sort());
  });

  it("filters by a comma-separated --status list", async () => {
    const result = await run(["actions", "--status", "planned,active", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["action-cite", "action-draft"].sort());
  });

  it("filters by case-insensitive --search across the entity's search fields", async () => {
    const result = await run(["actions", "--search", "CITATIONS", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["action-cite"]);
  });

  it("--search finds rows by words in any order, not only by the exact phrase", async () => {
    const reordered = await run(["actions", "--search", "citations fix", "--json"]);
    expect(ids(JSON.parse(reordered.text))).toEqual(["action-cite"]);
    const padded = await run(["actions", "--search", "please fix the citations urgently", "--json"]);
    expect(ids(JSON.parse(padded.text))).toContain("action-cite");
  });

  it("--search matches word stems by prefix, so renew finds renewal", async () => {
    const result = await run(["actions", "--search", "citation", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["action-cite"]);
  });

  it("--search ranks the row matching more words first and drops rows matching too few", async () => {
    const result = await run(["actions", "--search", "draft chapter 3 outline", "--json"]);
    const found = ids(JSON.parse(result.text));
    expect(found[0]).toBe("action-draft");
    expect(found).not.toContain("action-weed");
  });

  it("--search with an unrelated query returns nothing", async () => {
    const result = await run(["actions", "--search", "zebra submarine", "--json"]);
    expect(JSON.parse(result.text)).toEqual([]);
  });

  it("filters by --since, excluding items without the field or older than it", async () => {
    const result = await run(["actions", "--since=-7d", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["action-done", "action-weed"].sort());
  });

  it("filters commitments by --from and --to, from inclusive and to exclusive", async () => {
    const result = await run(["commitments", "--from", "today", "--to", "+7d", "--json"]);
    const found = ids(JSON.parse(result.text));
    expect(found).toContain("commitment-gym");
    expect(found).not.toContain("commitment-dentist");
  });

  it("reads today as midnight in the portal's timezone, not the host's", async () => {
    const state = fixtureRawState();
    const sessions = state.completedToday as Record<string, unknown>[];
    // 23:30 the evening before in the seed zone, but already the same UTC day as fixtureNow's midnight.
    const lastNight = { ...sessions[0], id: "session-last-night", startedAt: "2026-09-02T23:30:00+10:00" };
    state.completedToday = [...sessions, lastNight];
    const fromToday = await run(["sessions", "--from", "today", "--json"], state);
    expect(ids(JSON.parse(fromToday.text))).not.toContain("session-last-night");
    expect(ids(JSON.parse(fromToday.text))).toContain("session-email");
    const beforeToday = await run(["sessions", "--to", "today", "--json"], state);
    expect(ids(JSON.parse(beforeToday.text))).toEqual(["session-last-night"]);
  });

  it("refuses a --status the entity never carries, listing the ones it does", async () => {
    const result = await run(["actions", "--status", "bogus"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown action status "bogus"');
    expect(result.stderr).toContain(
      "Use one of: inbox, planned, active, doing, waiting, blocked, done, cancelled, archived."
    );
    const mixed = await run(["actions", "--status", "planned,bogus,nope"]);
    expect(mixed.exitCode).toBe(EXIT.usage);
    expect(mixed.stderr).toContain('"bogus", "nope"');
    const empty = await run(["actions", "--status", ","]);
    expect(empty.exitCode).toBe(EXIT.usage);
    expect(empty.stderr).toContain("--status needs at least one status");
  });

  it("accepts every valid --status, and a valid one for another entity", async () => {
    expect((await run(["actions", "--status", "planned,active,doing", "--json"])).exitCode).toBe(EXIT.ok);
    expect((await run(["captures", "--status", "pending", "--json"])).exitCode).toBe(EXIT.ok);
    const wrongEntity = await run(["captures", "--status", "planned"]);
    expect(wrongEntity.exitCode).toBe(EXIT.usage);
    expect(wrongEntity.stderr).toContain("Use one of: pending, confirmed, ignored, superseded.");
  });

  it("refuses a --sort field no record has, naming the sortable fields", async () => {
    const result = await run(["actions", "--sort", "nonexistentfield"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Cannot sort actions by "nonexistentfield"');
    expect(result.stderr).toContain("Sortable fields: id, title, projectId, status, remainingMinutes");
    const descending = await run(["actions", "--sort=-nonexistentfield"]);
    expect(descending.exitCode).toBe(EXIT.usage);
    expect(descending.stderr).toContain('"nonexistentfield"');
    expect((await run(["actions", "--sort", "nonexistentfield", "--count"])).exitCode).toBe(EXIT.usage);
  });

  it("still sorts by a dotted path and by a field only some records carry", async () => {
    expect((await run(["deliverables", "--sort", "steps.length", "--json"])).exitCode).toBe(EXIT.ok);
    expect((await run(["actions", "--sort", "deadlineAt", "--json"])).exitCode).toBe(EXIT.ok);
  });

  it("sorts ascending and descending, with missing values last either way", async () => {
    const ascending = await run(["commitments", "--sort", "startsAt", "--json"]);
    const descending = await run(["commitments", "--sort=-startsAt", "--json"]);
    expect(ids(JSON.parse(ascending.text))).toEqual(["commitment-dentist", "commitment-gym", "commitment-cancelled"]);
    expect(ids(JSON.parse(descending.text))).toEqual(["commitment-cancelled", "commitment-gym", "commitment-dentist"]);
  });

  it("applies --limit", async () => {
    const result = await run(["commitments", "--sort", "startsAt", "--limit", "2", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["commitment-dentist", "commitment-gym"]);
  });

  it("rejects a non-positive --limit", async () => {
    const result = await run(["actions", "--limit", "0"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("applies --offset, composing with --limit for paging", async () => {
    const result = await run(["commitments", "--sort", "startsAt", "--offset", "1", "--limit", "1", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["commitment-gym"]);
  });

  it("rejects a negative --offset", async () => {
    const result = await run(["actions", "--offset", "-1"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("filters actions by a comma-separated --scheduling-mode list", async () => {
    // The fixture never sets schedulingMode, so every action defaults to one_off.
    const matching = await run(["actions", "--scheduling-mode", "one_off", "--json"]);
    expect(ids(JSON.parse(matching.text)).sort()).toEqual(
      ["action-draft", "action-cite", "action-weed", "action-done"].sort()
    );
    const none = await run(["actions", "--scheduling-mode", "recurring,cadence", "--json"]);
    expect(JSON.parse(none.text)).toEqual([]);
  });

  it("refuses --scheduling-mode on an entity without that field", async () => {
    const result = await run(["areas", "--scheduling-mode", "recurring"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--scheduling-mode does not apply to areas");
  });

  it("filters with --where field=value, matching a comma-separated set of values", async () => {
    const result = await run(["actions", "--where", "status=planned,active", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["action-cite", "action-draft"].sort());
  });

  it("filters with --where field!=value, excluding a comma-separated set", async () => {
    const result = await run(["actions", "--where", "status!=done", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["action-cite", "action-draft", "action-weed"].sort());
  });

  it("--where is repeatable and ANDs its clauses, and reads dotted paths", async () => {
    const result = await run(["actions", "--where", "projectId=project-thesis", "--where", "status!=done", "--json"]);
    expect(ids(JSON.parse(result.text)).sort()).toEqual(["action-cite", "action-draft"].sort());
  });

  it("--where applies to any entity, unlike the built-in reference filters", async () => {
    const result = await run(["areas", "--where", "name=Study", "--json"]);
    expect(ids(JSON.parse(result.text))).toEqual(["area-study"]);
  });

  it("rejects a --where clause without an operator", async () => {
    const result = await run(["actions", "--where", "status"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("field=value");
  });

  it("--count prints a single total instead of the rows", async () => {
    const result = await run(["actions", "--status", "planned,active", "--count", "--json"]);
    expect(JSON.parse(result.text)).toEqual([{ count: 2 }]);
  });

  it("--count --by groups rows by a field", async () => {
    const result = await run(["actions", "--count", "--by", "schedulingMode", "--json"]);
    expect(JSON.parse(result.text)).toEqual([{ value: "one_off", count: 4 }]);
  });

  it("--count renders as a table too", async () => {
    const result = await run(["actions", "--count"]);
    expect(result.text).toContain("count");
    expect(result.text).toContain("4");
  });

  it("rejects --by without --count", async () => {
    const result = await run(["actions", "--by", "status"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--by only applies together with --count");
  });

  it("projects --fields in json mode", async () => {
    const result = await run(["actions", "--fields", "id,title", "--json"]);
    const rows = JSON.parse(result.text) as Record<string, unknown>[];
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["id", "title"]);
  });

  it("prints a JSON array that parses in full", async () => {
    const result = await run(["actions", "--json"]);
    const rows = JSON.parse(result.text);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it("prints one JSON object per line in jsonl mode", async () => {
    const result = await run(["actions", "--jsonl"]);
    expect(result.lines).toHaveLength(4);
    for (const line of result.lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(ids(result.lines.map((line) => JSON.parse(line)))).toEqual([
      "action-draft",
      "action-cite",
      "action-weed",
      "action-done"
    ]);
  });

  it("renders a table with a header row and ids", async () => {
    const result = await run(["actions"]);
    expect(result.lines).toHaveLength(1);
    const tableLines = result.text.split("\n");
    expect(tableLines[0]).toContain("id");
    expect(tableLines[0]).toContain("title");
    expect(result.text).toContain("action-draft");
  });

  it("never sends anything but GET /api/state", async () => {
    const result = await run(["actions", "--status", "planned"]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ method: "GET", path: "/api/state" });
  });

  it("--preset filters commitments pinned directly to a routine preset, by id", async () => {
    const result = await run(["commitments", "--preset", "preset-gym", "--json"], withGymPinnedToPreset());
    const rows = JSON.parse(result.text) as unknown[];
    expect(ids(rows)).toEqual(["commitment-gym"]);
  });

  it("--preset also resolves by the preset's exact name", async () => {
    const result = await run(["commitments", "--preset", "Gym prep", "--json"], withGymPinnedToPreset());
    const rows = JSON.parse(result.text) as unknown[];
    expect(ids(rows)).toEqual(["commitment-gym"]);
  });

  it("--preset does not apply to other entities", async () => {
    const result = await run(["actions", "--preset", "preset-gym"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });
});

describe("entity status lists", () => {
  it("every entity that takes --status names its statuses, and the fixture's records stay inside them", () => {
    const state = fixtureRawState() as unknown as Parameters<typeof entityItems>[0];
    for (const entity of entityCatalogue.filter((candidate) => candidate.filters.includes("status"))) {
      expect(entity.statuses, `${entity.name} lists no statuses`).toBeDefined();
      for (const item of entityItems(state, entity))
        if (typeof item.status === "string") expect(entity.statuses, entity.name).toContain(item.status);
    }
  });

  it("keeps where a narrowed row's text came from, only when it came from outside", async () => {
    const state = fixtureRawState();
    state.captures = [
      ...(state.captures as Record<string, unknown>[]),
      { id: "capture-mail", text: "Hi", status: "pending", proposalType: "unclassified", sourceType: "email" }
    ];
    const rows = JSON.parse((await run(["captures", "--fields", "id,text", "--json"], state)).text) as Record<
      string,
      unknown
    >[];
    expect(rows.map((row) => row.sourceType)).toEqual(expect.arrayContaining(["email"]));
    const plain = JSON.parse((await run(["captures", "--fields", "id,text", "--json"])).text) as Record<
      string,
      unknown
    >[];
    expect(plain.every((row) => !("sourceType" in row))).toBe(true);
  });
});
