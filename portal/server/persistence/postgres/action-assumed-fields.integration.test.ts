import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/**
 * `actions.assumed_fields` (migration 0126): which estimate and judgement fields are a default or a guess.
 * A save that says (the CLI) is stored as sent; a save that does not (the portal's own editor) keeps a stored
 * field only while its value is unchanged. The state reader returns the list as `assumedFields`.
 */
setupStateStoreSuite("openrhen_action_assumed_fields");

type Action = NonNullable<Awaited<ReturnType<typeof store.get>>>["actions"][number];

async function storedAssumed(id: string): Promise<string[]> {
  const rows = await sql<{ assumed_fields: string[] }[]>`SELECT assumed_fields FROM actions WHERE id=${id}`;
  return rows[0]?.assumed_fields ?? [];
}

/** The action as the portal editor sends it back: every field, and no word about what is assumed. */
const editorSave = (action: Action, change: Record<string, unknown> = {}) =>
  store.saveAction({
    expectedVersion: action.version!,
    action: {
      id: action.id,
      projectId: action.projectId,
      title: action.title,
      status: action.status,
      optimisticMinutes: action.optimisticMinutes,
      expectedMinutes: action.expectedMinutes,
      pessimisticMinutes: action.pessimisticMinutes,
      remainingMinutes: action.remainingMinutes,
      energy: action.energy,
      minimumSessionMinutes: action.minimumSessionMinutes,
      maximumSessionMinutes: action.maximumSessionMinutes,
      splittable: action.splittable,
      setupMinutes: action.setupMinutes,
      importance: action.importance,
      consequence: action.consequence,
      contexts: [],
      dependencyIds: [],
      ...change
    } as never
  });

/** A new action with a full estimate and the CLI's other starting values, saying which it assumed. */
async function createAssumed(assumed: string[] | undefined, id = crypto.randomUUID()): Promise<Action> {
  await store.put(createSeedState(fixedNow));
  const project = (await store.get())!.projects[0]!;
  const state = await store.saveAction({
    expectedVersion: null,
    action: {
      id,
      projectId: project.id,
      title: "Call the bank",
      status: "planned",
      optimisticMinutes: 30,
      expectedMinutes: 60,
      pessimisticMinutes: 90,
      remainingMinutes: 60,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      splittable: true,
      setupMinutes: 0,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: [],
      ...(assumed ? { assumedFields: assumed } : {})
    } as never
  });
  return state.actions.find((item) => item.id === id)!;
}

describe("a save that lists assumed fields", () => {
  it("stores them on the row and returns them in the state, in the canonical order", async () => {
    const created = await createAssumed(["energy", "expectedMinutes", "importance"]);
    expect(await storedAssumed(created.id)).toEqual(["expectedMinutes", "energy", "importance"]);
    expect(created.assumedFields).toEqual(["expectedMinutes", "energy", "importance"]);
    expect((await store.get())!.actions.find((item) => item.id === created.id)!.assumedFields).toEqual([
      "expectedMinutes",
      "energy",
      "importance"
    ]);
  });

  it("is replaced by the next save that lists them, even with an empty list", async () => {
    const created = await createAssumed(["expectedMinutes", "energy"]);
    const state = await store.saveAction({
      expectedVersion: created.version!,
      action: { ...created, assumedFields: ["energy"], contexts: [], dependencyIds: [] } as never
    });
    expect(state.actions.find((item) => item.id === created.id)!.assumedFields).toEqual(["energy"]);
    const cleared = await store.saveAction({
      expectedVersion: state.actions.find((item) => item.id === created.id)!.version!,
      action: { ...created, assumedFields: [], contexts: [], dependencyIds: [] } as never
    });
    expect(cleared.actions.find((item) => item.id === created.id)!.assumedFields).toBeUndefined();
    expect(await storedAssumed(created.id)).toEqual([]);
  });
});

describe("a save that does not say", () => {
  it("starts a new action with nothing assumed", async () => {
    const created = await createAssumed(undefined);
    expect(created.assumedFields).toBeUndefined();
    expect(await storedAssumed(created.id)).toEqual([]);
  });

  it("keeps every stored field when the editor sends the values back unchanged", async () => {
    const created = await createAssumed(["expectedMinutes", "energy", "importance"]);
    const state = await editorSave(created, { title: "Call the bank today" });
    const saved = state.actions.find((item) => item.id === created.id)!;
    expect(saved.title).toBe("Call the bank today");
    expect(saved.assumedFields).toEqual(["expectedMinutes", "energy", "importance"]);
  });

  it("stops calling a field assumed once the editor changes its value, and only that field", async () => {
    const created = await createAssumed(["expectedMinutes", "energy", "importance"]);
    const state = await editorSave(created, { expectedMinutes: 45, importance: 5 });
    const saved = state.actions.find((item) => item.id === created.id)!;
    expect(saved.expectedMinutes).toBe(45);
    expect(saved.assumedFields).toEqual(["energy"]);
    expect(await storedAssumed(created.id)).toEqual(["energy"]);
  });

  it("clears the list when every listed value changed", async () => {
    const created = await createAssumed(["energy"]);
    const state = await editorSave(created, { energy: "high" });
    expect(state.actions.find((item) => item.id === created.id)!.assumedFields).toBeUndefined();
    expect(await storedAssumed(created.id)).toEqual([]);
  });

  it("does not turn a field assumed because it changed", async () => {
    const created = await createAssumed(["energy"]);
    const state = await editorSave(created, { importance: 4 });
    expect(state.actions.find((item) => item.id === created.id)!.assumedFields).toEqual(["energy"]);
  });
});

describe("rows from before the column, a whole-state put and a session", () => {
  it("read as nothing assumed", async () => {
    await store.put(createSeedState(fixedNow));
    const actions = (await store.get())!.actions;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((item) => item.assumedFields === undefined)).toBe(true);
    const rows = await sql<{ assumed_fields: string[] }[]>`SELECT assumed_fields FROM actions`;
    expect(rows.every((row) => row.assumed_fields.length === 0)).toBe(true);
  });

  it("are carried through a whole-state put", async () => {
    const seed = createSeedState(fixedNow);
    const [first, ...rest] = seed.actions;
    await store.put({ ...seed, actions: [{ ...first!, assumedFields: ["setupMinutes", "energy", "bogus"] }, ...rest] });
    const read = (await store.get())!.actions;
    expect(read.find((item) => item.title === first!.title)!.assumedFields).toEqual(["energy", "setupMinutes"]);
    expect(read.filter((item) => item.assumedFields)).toHaveLength(1);
  });
});
