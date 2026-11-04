import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The pulse on plan design note: the three pulse lapse thresholds are settings (null = default, an agent may
 * write them), and a commitment or a recurrence rule carries a check-in allowance (null = default 15).
 */
setupStateStoreSuite("openrhen_pulse_allowance");

const saveSettings = (entity: Record<string, unknown>, expectedVersion: number | null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "settings",
    entity
  });

const startsAt = new Date(fixedNow.getTime() + 86_400_000).toISOString();
const endsAt = new Date(fixedNow.getTime() + 86_400_000 + 3_600_000).toISOString();
const saveCommitment = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "commitment",
    entity: {
      id: "dentist-1",
      title: "Dentist",
      startsAt,
      endsAt,
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...entity
    }
  });
const dentist = (state: { commitments: { title: string }[] }) =>
  state.commitments.find((item) => item.title === "Dentist") as
    ((typeof state.commitments)[number] & Record<string, any>) | undefined;

describe("pulse thresholds in settings", () => {
  it("default to absent, persist, keep on a silent save, and clear back to the default with null", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.settings.pulseUnknownToOffMinutes).toBeUndefined();
    expect(state.settings.pulseFurtherPrompts).toBeUndefined();
    expect(state.settings.pulseUnknownHardOffMinutes).toBeUndefined();

    state = await saveSettings(
      { pulseUnknownToOffMinutes: 40, pulseFurtherPrompts: 2, pulseUnknownHardOffMinutes: 90 },
      state.settings.version ?? null
    );
    expect(state.settings.pulseUnknownToOffMinutes).toBe(40);
    expect(state.settings.pulseFurtherPrompts).toBe(2);
    expect(state.settings.pulseUnknownHardOffMinutes).toBe(90);

    // A page that never heard of the fields leaves them alone.
    state = await saveSettings({ sessionBreakMinutes: 20 }, state.settings.version ?? null);
    expect(state.settings.pulseUnknownToOffMinutes).toBe(40);

    state = await saveSettings(
      { pulseUnknownToOffMinutes: null, pulseFurtherPrompts: null, pulseUnknownHardOffMinutes: null },
      state.settings.version ?? null
    );
    expect(state.settings.pulseUnknownToOffMinutes).toBeUndefined();
    const rows = await sql<
      { pulse_unknown_to_off_minutes: number | null }[]
    >`SELECT pulse_unknown_to_off_minutes FROM user_preferences`;
    expect(rows[0]?.pulse_unknown_to_off_minutes).toBeNull();
  });

  it("refuses values outside the range and a hard limit shorter than the soft one", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const version = state.settings.version ?? null;
    await expect(saveSettings({ pulseUnknownToOffMinutes: 1 }, version)).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(saveSettings({ pulseFurtherPrompts: 11 }, version)).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(
      saveSettings({ pulseUnknownToOffMinutes: 60, pulseUnknownHardOffMinutes: 30 }, version)
    ).rejects.toBeInstanceOf(InvalidCommandError);
  });
});

describe("commitment check-in allowance", () => {
  it("is absent by default, persists a custom value including 0, keeps it on a silent save and clears with null", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await saveCommitment({});
    expect(dentist(state)?.checkInExtraMinutes).toBeUndefined();

    state = await saveCommitment({ checkInExtraMinutes: 40 }, dentist(state)?.version ?? null);
    expect(dentist(state)?.checkInExtraMinutes).toBe(40);

    state = await saveCommitment({ title: "Dentist" }, dentist(state)?.version ?? null);
    expect(dentist(state)?.checkInExtraMinutes).toBe(40);

    state = await saveCommitment({ checkInExtraMinutes: 0 }, dentist(state)?.version ?? null);
    expect(dentist(state)?.checkInExtraMinutes).toBe(0);

    state = await saveCommitment({ checkInExtraMinutes: null }, dentist(state)?.version ?? null);
    expect(dentist(state)?.checkInExtraMinutes).toBeUndefined();
  });

  it("refuses a negative or fractional allowance", async () => {
    await store.put(createSeedState(fixedNow));
    await expect(saveCommitment({ checkInExtraMinutes: -5 })).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(saveCommitment({ checkInExtraMinutes: 2.5 })).rejects.toBeInstanceOf(InvalidCommandError);
  });
});

describe("recurrence rule check-in allowance", () => {
  it("persists on the rule and reads back", async () => {
    await store.put(createSeedState(fixedNow));
    const ruleId = crypto.randomUUID();
    const rule = {
      id: ruleId,
      title: "Class",
      timezone: "Australia/Sydney",
      startDate: "2026-10-01",
      repeat: { unit: "days" as const, intervalDays: 7 },
      localStartTime: "09:00",
      localEndTime: "10:00",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      presence: "blocking" as const
    };
    let state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: { ...rule, checkInExtraMinutes: 45 }
    });
    const stored = state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!;
    expect(stored.checkInExtraMinutes).toBe(45);
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: stored.version ?? null,
      rule: { ...rule, title: "Class (moved)" }
    });
    expect(state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!.checkInExtraMinutes).toBe(45);
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!.version ?? null,
      rule: { ...rule, checkInExtraMinutes: null }
    });
    expect(state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!.checkInExtraMinutes).toBeUndefined();
  });
});
