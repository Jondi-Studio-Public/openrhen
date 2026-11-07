import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/**
 * Snooze is only a later `availableFrom` on a saved action, so the offer log records it inside the `saveAction`
 * transaction by diffing the stored value: a later date logs one `snoozed` row; a save that leaves the date alone, moves
 * it earlier or into the past, or creates the action logs none.
 */
setupStateStoreSuite("openrhen_offer_log_snooze");

const saveCommand = (action: Record<string, unknown>, expectedVersion: number | null) => ({
  commandId: crypto.randomUUID(),
  expectedVersion,
  action: { contexts: [], dependencyIds: [], ...action } as never
});

const snoozes = () =>
  sql<{ target_id: string; label: string; actor: string; detail: Record<string, unknown>; rank_basis: string }[]>`
    SELECT target_id, label, actor, detail, rank_basis FROM offer_log WHERE event='snoozed' ORDER BY occurred_at`;

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe("snooze in the offer log", () => {
  it("logs a later availableFrom once, and nothing for an unchanged, earlier, past or first date", async () => {
    await store.put(createSeedState(fixedNow));
    const action = (await store.get())!.actions[0]!;

    // First availability on an existing action with none stored: a snooze (it was available before, now it waits).
    let state = await runWithActor(null, () =>
      store.saveAction(saveCommand({ ...action, availableFrom: hoursFromNow(5) }, action.version!))
    );
    let rows = await snoozes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_id: action.id, label: action.title, actor: "person" });
    expect(rows[0]!.detail).toMatchObject({ command: "save_action", previous: null });
    expect(typeof rows[0]!.detail.until).toBe("string");

    // Re-saving the same date, or an earlier one, or a date in the past: no new row.
    const current = () => state.actions.find((item) => item.id === action.id)!;
    state = await store.saveAction(saveCommand({ ...current(), title: "Renamed" }, current().version!));
    state = await store.saveAction(saveCommand({ ...current(), availableFrom: hoursFromNow(2) }, current().version!));
    state = await store.saveAction(saveCommand({ ...current(), availableFrom: hoursFromNow(-3) }, current().version!));
    expect(await snoozes()).toHaveLength(1);

    // Pushed later again by an agent: a second row, with the previous date.
    await runWithActor("claude", () =>
      store.saveAction(saveCommand({ ...current(), availableFrom: hoursFromNow(30) }, current().version!))
    );
    rows = await snoozes();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor: "claude" });
    expect(rows[1]!.detail.previous).not.toBeNull();
  });

  it("logs nothing for a new action created with an availableFrom", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    await store.saveAction(
      saveCommand(
        {
          id: crypto.randomUUID(),
          projectId: project.id,
          title: "Later",
          status: "planned",
          availableFrom: hoursFromNow(48),
          optimisticMinutes: 5,
          expectedMinutes: 10,
          pessimisticMinutes: 15,
          remainingMinutes: 10,
          energy: "low",
          minimumSessionMinutes: 5,
          maximumSessionMinutes: 15,
          splittable: false,
          setupMinutes: 0,
          importance: 3,
          consequence: 3
        },
        null
      )
    );
    expect(await snoozes()).toHaveLength(0);
  });

  it("rolls the save back when the log insert fails", async () => {
    await store.put(createSeedState(fixedNow));
    const action = (await store.get())!.actions[0]!;
    await sql`ALTER TABLE offer_log ADD CONSTRAINT offer_log_snooze_refuse CHECK (event <> 'snoozed')`;
    try {
      await expect(
        store.saveAction(
          saveCommand({ ...action, title: "Should not stick", availableFrom: hoursFromNow(9) }, action.version!)
        )
      ).rejects.toThrow();
    } finally {
      await sql`ALTER TABLE offer_log DROP CONSTRAINT offer_log_snooze_refuse`;
    }
    const stored = await sql<{ title: string }[]>`SELECT title FROM actions WHERE id=${action.id}`;
    expect(stored[0]!.title).toBe(action.title);
  });
});
