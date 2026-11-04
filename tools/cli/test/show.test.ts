import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
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
  const exitCode = await runCli(["show", ...argv], {
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

/** A project-thesis with `extra` additional actions, for exercising the relation cap. */
function stateWithBulkActions(extra: number): Record<string, unknown> {
  const state = fixtureRawState();
  const actions = state.actions as Record<string, unknown>[];
  const template = actions[0] as Record<string, unknown>;
  const bulk = Array.from({ length: extra }, (_, index) => ({
    ...template,
    id: `action-bulk-${index}`,
    title: `Bulk ${index}`
  }));
  state.actions = [...actions, ...bulk];
  return state;
}

/**
 * A routine preset with one place inheriting it, plus three future commitments exercising the three
 * `sync` outcomes `show routine-preset` can report: one still tracking it via place default with every
 * step pending (inherits), one pinned directly with one step already done and one still pending — the
 * sync is per step, so that pending step still keeps tracking the preset (inherits (1 step done)) — and
 * one that was pinned and later detached by hand (custom). Entirely additive: no existing fixture entry
 * is touched.
 */
function stateWithRoutinePresetUsage(): Record<string, unknown> {
  const state = fixtureRawState();
  const contexts = state.conditionDefinitions as Record<string, unknown>[];
  const commitments = state.commitments as Record<string, unknown>[];
  const routineSteps = state.routineSteps as Record<string, unknown>[];
  const routinePresets = state.routinePresets as Record<string, unknown>[];

  state.conditionDefinitions = [
    ...contexts,
    {
      id: "ctx-office",
      name: "Office",
      kind: "location",
      address: "9 Work Street",
      defaultRoutinePresetId: "preset-declutter"
    }
  ];
  state.routinePresets = [
    ...routinePresets,
    {
      id: "preset-declutter",
      name: "Declutter",
      activityName: "Declutter",
      status: "active",
      steps: [
        {
          id: "preset-step-tidy",
          title: "Tidy desk",
          durationMinutes: 10,
          sequence: 0,
          timingRule: "flexible",
          energy: "low",
          contexts: []
        }
      ]
    }
  ];
  state.commitments = [
    ...commitments,
    {
      id: "commitment-inherits",
      title: "Office day",
      startsAt: "2026-09-10T09:00:00+10:00",
      endsAt: "2026-09-10T17:00:00+10:00",
      status: "confirmed",
      locationId: "ctx-office",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    },
    {
      id: "commitment-partly-done",
      title: "Client visit",
      startsAt: "2026-09-11T09:00:00+10:00",
      endsAt: "2026-09-11T10:00:00+10:00",
      status: "confirmed",
      routineSource: "preset",
      routinePresetId: "preset-declutter",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    },
    {
      id: "commitment-detached",
      title: "Board meeting",
      startsAt: "2026-09-12T09:00:00+10:00",
      endsAt: "2026-09-12T10:00:00+10:00",
      status: "confirmed",
      routineSource: "custom",
      routinePresetId: "preset-declutter",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    }
  ];
  state.routineSteps = [
    ...routineSteps,
    {
      id: "step-partly-done-done",
      commitmentId: "commitment-partly-done",
      title: "Tidy desk",
      durationMinutes: 10,
      sequence: 0,
      timingRule: "flexible",
      energy: "low",
      contexts: [],
      phase: "before",
      status: "completed"
    },
    {
      id: "step-partly-done-pending",
      commitmentId: "commitment-partly-done",
      title: "Print handout",
      durationMinutes: 5,
      sequence: 1,
      timingRule: "flexible",
      energy: "low",
      contexts: [],
      phase: "before",
      status: "pending"
    }
  ];
  return state;
}

describe("show", () => {
  it("shows a project's actions and deliverables", async () => {
    const result = await run(["project", "project-thesis"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("Actions (3)");
    expect(result.text).toContain("action-draft");
    expect(result.text).toContain("Deliverables (1)");
    expect(result.text).toContain("deliverable-chapter");
  });

  it("shows a project's actions and deliverables in json", async () => {
    const result = await run(["project", "project-thesis", "--json"]);
    const doc = JSON.parse(result.text) as {
      entity: string;
      item: { id: string };
      relations: { actions: { id: string }[]; deliverables: { id: string }[]; outcome: unknown; area: unknown };
    };
    expect(doc.entity).toBe("project");
    expect(doc.item.id).toBe("project-thesis");
    expect(doc.relations.actions.map((a) => a.id).sort()).toEqual(
      ["action-draft", "action-cite", "action-done"].sort()
    );
    expect(doc.relations.deliverables.map((d) => d.id)).toEqual(["deliverable-chapter"]);
    expect(doc.relations.outcome).toMatchObject({ id: "outcome-degree" });
    expect(doc.relations.area).toMatchObject({ id: "area-study" });
  });

  it("shows a commitment's place, rule, and routine steps", async () => {
    const result = await run(["commitment", "commitment-gym"]);
    expect(result.text).toContain("Place");
    expect(result.text).toContain("ctx-gym");
    expect(result.text).toContain("Rule");
    expect(result.text).toContain("rule-gym");
    expect(result.text).toContain("Routine steps (2)");
    expect(result.text).toContain("step-pack");
    expect(result.text).toContain("step-shower");
  });

  it("shows a live condition's linked recurring series or one-off commitment, by title", async () => {
    const state = fixtureRawState();
    const contexts = state.conditionDefinitions as Record<string, unknown>[];
    state.conditionDefinitions = [
      ...contexts,
      { id: "ctx-gym-class", name: "Gym class", kind: "live", recurrenceRuleId: "rule-gym" },
      { id: "ctx-dentist-visit", name: "Dentist visit", kind: "live", commitmentId: "commitment-dentist" }
    ];

    const rule = await run(["condition", "ctx-gym-class"], state);
    expect(rule.text).toContain("Recurring commitment");
    // The rule's own title, not the bare "rule-gym" id — the whole point of resolving the reference.
    expect(rule.text).toContain("Gym");

    const commitment = await run(["condition", "ctx-dentist-visit"], state);
    expect(commitment.text).toContain("Commitment");
    expect(commitment.text).toContain("Dentist");
  });

  it("shows an action's dependencies and dependants", async () => {
    const draft = await run(["action", "action-draft", "--json"]);
    const draftDoc = JSON.parse(draft.text) as { relations: { dependants: { id: string }[]; dependencies: unknown[] } };
    expect(draftDoc.relations.dependencies).toEqual([]);
    expect(draftDoc.relations.dependants.map((a) => a.id)).toEqual(["action-cite"]);

    const cite = await run(["action", "action-cite", "--json"]);
    const citeDoc = JSON.parse(cite.text) as { relations: { dependencies: { id: string }[] } };
    expect(citeDoc.relations.dependencies.map((a) => a.id)).toEqual(["action-draft"]);
  });

  it("resolves a unique id prefix", async () => {
    const result = await run(["action", "action-dr", "--json"]);
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(result.text) as { item: { id: string } };
    expect(doc.item.id).toBe("action-draft");
  });

  it("refuses an ambiguous id prefix, listing the candidates", async () => {
    const result = await run(["action", "action-d"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("action-draft");
    expect(result.stderr).toContain("action-done");
  });

  it("reports notFound for an id that matches nothing", async () => {
    const result = await run(["action", "no-such-action"]);
    expect(result.exitCode).toBe(EXIT.notFound);
  });

  it("resolves an entity by its display name when nothing matches the id", async () => {
    const result = await run(["project", "thesis", "--json"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect((JSON.parse(result.text) as { item: { title: string } }).item.title).toBe("Thesis");
  });

  it("names both id and name in the notFound message", async () => {
    const result = await run(["project", "No Such Project"]);
    expect(result.exitCode).toBe(EXIT.notFound);
    expect(result.stderr).toContain("id or name");
  });

  it("refuses an unknown entity", async () => {
    const result = await run(["widget", "anything"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });

  // `save` has always accepted "place"/"condition-definition" alongside "places"/"condition-definitions"
  // (ENTITY_TYPES in save.ts); `findEntity` (entities.ts), shared by `show` and `list`, was missing the
  // two singular forms, so `save place …` worked but `show place …` refused the entity outright.
  it('accepts the singular "place" and "condition-definition" aliases, same as save', async () => {
    const byPlace = await run(["place", "ctx-home", "--json"]);
    expect(byPlace.exitCode).toBe(EXIT.ok);
    expect((JSON.parse(byPlace.text) as { item: { id: string } }).item.id).toBe("ctx-home");

    const byConditionDefinition = await run(["condition-definition", "ctx-home", "--json"]);
    expect(byConditionDefinition.exitCode).toBe(EXIT.ok);
    expect((JSON.parse(byConditionDefinition.text) as { item: { id: string } }).item.id).toBe("ctx-home");
  });

  it("never sends anything but GET /api/state", async () => {
    const result = await run(["project", "project-thesis"]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ method: "GET", path: "/api/state" });
  });

  it("--brief prints only the record, omitting relations in JSON", async () => {
    const result = await run(["project", "project-thesis", "--brief", "--json"]);
    const doc = JSON.parse(result.text) as { entity: string; item: { id: string }; relations?: unknown };
    expect(doc.entity).toBe("project");
    expect(doc.item.id).toBe("project-thesis");
    expect(doc.relations).toBeUndefined();
  });

  it("--brief prints only the record in table mode too", async () => {
    const result = await run(["project", "project-thesis", "--brief"]);
    expect(result.text).toContain("project-thesis");
    expect(result.text).not.toContain("Actions (");
    expect(result.text).not.toContain("Deliverables (");
  });

  it("caps a relation list at 20 rows by default, noting the total and how to see the rest", async () => {
    const state = stateWithBulkActions(25); // 3 thesis actions in the fixture + 25 bulk = 28
    const jsonResult = await run(["project", "project-thesis", "--json"], state);
    const doc = JSON.parse(jsonResult.text) as {
      relations: { actions: { id: string }[] };
      truncated?: Record<string, { total: number; shown: number; hint: string | null }>;
    };
    expect(doc.relations.actions).toHaveLength(20);
    expect(doc.truncated?.actions).toEqual({
      total: 28,
      shown: 20,
      hint: "list actions --project project-thesis"
    });

    const tableResult = await run(["project", "project-thesis"], state);
    expect(tableResult.text).toContain("Actions (28)");
    expect(tableResult.text).toContain("+8 more, use `rhen list actions --project project-thesis`");
  });

  it("--all lifts the relation cap", async () => {
    const state = stateWithBulkActions(25);
    const uncapped = await run(["project", "project-thesis", "--all", "--json"], state);
    const doc = JSON.parse(uncapped.text) as { relations: { actions: { id: string }[] }; truncated?: unknown };
    expect(doc.relations.actions).toHaveLength(28);
    expect(doc.truncated).toBeUndefined();
  });

  it("shows a routine preset's places and which future commitments inherit (in full or in part), or are custom", async () => {
    const state = stateWithRoutinePresetUsage();
    const result = await run(["routine-preset", "preset-declutter", "--json"], state);
    const doc = JSON.parse(result.text) as {
      relations: { places: { id: string }[]; usedBy: { id: string; sync: string }[] };
    };
    expect(doc.relations.places.map((place) => place.id)).toEqual(["ctx-office"]);
    const byId = new Map(doc.relations.usedBy.map((row) => [row.id, row.sync]));
    expect(byId.get("commitment-inherits")).toBe("inherits");
    expect(byId.get("commitment-partly-done")).toBe("inherits (1 step done)");
    expect(byId.get("commitment-detached")).toBe("custom");
    expect(doc.relations.usedBy).toHaveLength(3);

    const table = await run(["routine-preset", "preset-declutter"], state);
    expect(table.text).toContain("inherits (1 step done)");
    expect(table.text).toContain("custom");
  });

  it("resolves a step's cadenceActionId to the linked action's title", async () => {
    const state = stateWithRoutinePresetUsage();
    const routinePresets = state.routinePresets as Record<string, unknown>[];
    state.routinePresets = routinePresets.map((preset) =>
      preset.id === "preset-declutter"
        ? {
            ...preset,
            steps: [
              ...(preset.steps as Record<string, unknown>[]),
              {
                id: "preset-step-practice",
                title: "Practice piano",
                durationMinutes: 15,
                sequence: 1,
                timingRule: "flexible",
                energy: "low",
                contexts: [],
                cadenceActionId: "action-draft"
              }
            ]
          }
        : preset
    );
    const result = await run(["routine-preset", "preset-declutter", "--json"], state);
    const doc = JSON.parse(result.text) as {
      relations: { cadenceLinks: { id: string; title: string; cadenceAction: string }[] };
    };
    expect(doc.relations.cadenceLinks).toHaveLength(1);
    expect(doc.relations.cadenceLinks[0]).toMatchObject({
      id: "preset-step-practice",
      title: "Practice piano",
      cadenceAction: "Draft chapter 3"
    });

    const table = await run(["routine-preset", "preset-declutter"], state);
    expect(table.text).toContain("Steps linked to a cadence action");
    expect(table.text).toContain("Draft chapter 3");
  });

  it("excludes a cancelled or past commitment from a routine preset's usedBy list", async () => {
    const state = stateWithRoutinePresetUsage();
    const commitments = state.commitments as Record<string, unknown>[];
    state.commitments = commitments.map((commitment) =>
      commitment.id === "commitment-inherits" ? { ...commitment, status: "cancelled" } : commitment
    );
    const result = await run(["routine-preset", "preset-declutter", "--json"], state);
    const doc = JSON.parse(result.text) as { relations: { usedBy: { id: string }[] } };
    expect(doc.relations.usedBy.map((row) => row.id)).not.toContain("commitment-inherits");
  });

  it("lists prerequisites of other kinds and what is required by them", async () => {
    const state = fixtureRawState();
    (state.projects as Record<string, unknown>[])[1]!.prerequisites = [
      { kind: "deliverable", id: "deliverable-chapter" }
    ];
    (state.actions as Record<string, unknown>[]).find((a) => a.id === "action-cite")!.prerequisites = [
      { kind: "project", id: "project-garden" }
    ];
    type Rel = {
      relations: { prerequisites: { kind: string; id: string }[]; requiredBy: { kind: string; id: string }[] };
    };
    const garden = JSON.parse((await run(["project", "project-garden", "--json"], state)).text) as Rel;
    expect(garden.relations.prerequisites.map((r) => `${r.kind}:${r.id}`)).toEqual(["deliverable:deliverable-chapter"]);
    expect(garden.relations.requiredBy.map((r) => `${r.kind}:${r.id}`)).toEqual(["action:action-cite"]);
    const chapter = JSON.parse((await run(["deliverable", "deliverable-chapter", "--json"], state)).text) as Rel;
    expect(chapter.relations.requiredBy.map((r) => `${r.kind}:${r.id}`)).toEqual(["project:project-garden"]);
    const cite = await run(["action", "action-cite"], state);
    expect(cite.text).toContain("Prerequisites (other kinds)");
  });

  it("keeps the source on a related commitment that came from a calendar", async () => {
    const state = fixtureRawState();
    state.commitments = (state.commitments as Record<string, unknown>[]).map((commitment) =>
      commitment.id === "commitment-gym" ? { ...commitment, sourceType: "example_shared" } : commitment
    );
    const doc = JSON.parse((await run(["condition", "ctx-gym", "--json"], state)).text) as {
      relations: { commitments: { id: string; sourceType?: string }[] };
    };
    const gym = doc.relations.commitments.find((row) => row.id === "commitment-gym");
    expect(gym?.sourceType).toBe("example_shared");
    expect(doc.relations.commitments.filter((row) => row.id !== "commitment-gym")).toEqual([]);
  });
});
