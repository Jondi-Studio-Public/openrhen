import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The writes behind the fact freshness design note: `energySetAt` in the situation record moves only
 * when energy is actually said, and a paused session carries when it was paused (where its last
 * segment ended).
 */
setupStateStoreSuite("openrhen_fact_freshness");

describe("energySetAt", () => {
  const saveAvailability = async (state: Awaited<ReturnType<typeof store.get>>, entity: Record<string, unknown>) =>
    store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state!.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: { assertedConditions: state!.assertedConditions, ...entity }
    });

  it("is undated until energy is said, then moves only when the value changes or is asserted again", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.currentSituation.energySetAt).toBeUndefined();

    // A write that only restates the stored energy dates nothing: a place change resends it.
    state = await saveAvailability(state, {
      currentEnergy: state.currentEnergy,
      currentSituation: { travelOff: true }
    });
    expect(state.currentSituation.energySetAt).toBeUndefined();

    // A different value is said now.
    const changed = state.currentEnergy === "low" ? "high" : "low";
    const before = Date.now();
    state = await saveAvailability(state, { currentEnergy: changed });
    const first = state.currentSituation.energySetAt!;
    expect(state.currentEnergy).toBe(changed);
    expect(Date.parse(first)).toBeGreaterThanOrEqual(before - 1000);

    // Restating it, or moving the place with it resent, leaves the date where it was.
    await new Promise((resolve) => setTimeout(resolve, 15));
    state = await saveAvailability(state, { currentEnergy: changed, currentSituation: { travelOff: false } });
    expect(state.currentSituation.energySetAt).toBe(first);

    // Asserting it again ("still low") dates it afresh even though the value is the same.
    state = await saveAvailability(state, { currentEnergy: changed, energyAsserted: true });
    expect(Date.parse(state.currentSituation.energySetAt!)).toBeGreaterThan(Date.parse(first));
  });

  it("ignores a date the payload carries, since only the server says when energy was said", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await saveAvailability(state, {
      currentEnergy: state.currentEnergy,
      currentSituation: { energySetAt: "2020-01-01T00:00:00.000Z" }
    });
    expect(state.currentSituation.energySetAt).toBeUndefined();
    const changed = state.currentEnergy === "low" ? "high" : "low";
    state = await saveAvailability(state, {
      currentEnergy: changed,
      currentSituation: { energySetAt: "2020-01-01T00:00:00.000Z" }
    });
    expect(Date.parse(state.currentSituation.energySetAt!)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});

describe("an open session's pausedAt", () => {
  it("is where a paused session's last segment ended, and absent on a running one", async () => {
    await store.put(createSeedState(fixedNow));
    const userId = await ensureUser(sql);
    const sessionId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const hoursAgo = (hours: number) => new Date(fixedNow.getTime() - hours * 60 * 60_000);
    const pausedAt = hoursAgo(5);
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,paused_remaining_seconds)
      VALUES (${sessionId},${userId},'fixed_commitment',${targetId},'Class','paused',${hoursAgo(8)},${fixedNow},${hoursAgo(8)},60,0,1200)
    `;
    // Two stretches before the pause; the later one's end is when it was paused.
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at) VALUES (${sessionId},${hoursAgo(8)},${hoursAgo(7)}),(${sessionId},${hoursAgo(6)},${pausedAt})`;
    let state = (await store.get())!;
    expect(state.activeSession).toMatchObject({ id: sessionId, status: "paused", pausedAt: pausedAt.toISOString() });

    // Moved to awaiting feedback while paused (`request_feedback` keeps the paused remainder): its end is still the pause.
    await sql`UPDATE sessions SET status='awaiting_feedback', feedback_requested_at=${hoursAgo(1)} WHERE id=${sessionId}`;
    state = (await store.get())!;
    expect(state.activeSession).toMatchObject({ status: "feedback", pausedAt: pausedAt.toISOString() });

    await sql`UPDATE sessions SET status='running', paused_remaining_seconds=NULL WHERE id=${sessionId}`;
    state = (await store.get())!;
    expect(state.activeSession?.status).toBe("running");
    expect(state.activeSession?.pausedAt).toBeUndefined();
  });
});

describe("a session left open", () => {
  it("still refuses a start of other work, and nothing is closed or recorded on its behalf", async () => {
    await store.put(createSeedState(fixedNow));
    const [first, second] = (await store.get())!.actions;
    const started = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: first!.version ?? null,
      type: "start",
      actionId: first!.id,
      plannedMinutes: 15
    });
    const open = started.activeSession!;
    // Forgotten overnight: it began, and was due to end, eighteen hours ago.
    await sql`UPDATE sessions SET planned_started_at=planned_started_at-INTERVAL '18 hours',started_at=started_at-INTERVAL '18 hours',planned_end_at=planned_end_at-INTERVAL '18 hours' WHERE id=${open.id}`;
    await sql`UPDATE session_segments SET started_at=started_at-INTERVAL '18 hours' WHERE session_id=${open.id}`;

    await expect(
      store.runSessionCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: second!.version ?? null,
        type: "start",
        actionId: second!.id,
        plannedMinutes: 15
      })
    ).rejects.toThrow(/Another session is already open \(id [^)]+\)/);

    const after = (await store.get())!;
    expect(after.activeSession).toMatchObject({ id: open.id, status: "running" });
    expect(after.completedToday).toEqual([]);
  });
});
