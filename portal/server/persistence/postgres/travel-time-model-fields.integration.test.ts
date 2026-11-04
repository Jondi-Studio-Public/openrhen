import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The task-004 writes from the travel time model design note: `usualTransportMode` on a place,
 * `defaultTransportMode` on settings, `travelOff` on `currentSituation`, the write schema's refusal of
 * an explicitly emptied `transportModes`, and `latenessMatters`/`transportMode` on a commitment
 * occurrence (schedule-source overlay detach included, the same rule `presence`/`contactId` already
 * follow).
 */
setupStateStoreSuite("openrhen_travel_fields");

describe("travel-time-model write paths", () => {
  it("round-trips a place's usual transport mode, location-only", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: {
        id: "the-gym",
        name: "The gym",
        kind: "location",
        latitude: -36.12,
        longitude: 146.89,
        usualTransportMode: "bike"
      }
    });
    expect(state.conditionDefinitions.find((entry) => entry.id === "the-gym")?.usualTransportMode).toBe("bike");
    // Not a location: the field never lands, whatever the payload sent.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "car-capable", name: "Can drive", kind: "capability", usualTransportMode: "car" }
    });
    expect(state.conditionDefinitions.find((entry) => entry.id === "car-capable")?.usualTransportMode).toBeUndefined();
    // An invalid mode is refused, same as everywhere else the write schema checks a mode.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "condition_definition",
        entity: {
          id: "bad-mode-place",
          name: "Bad mode place",
          kind: "location",
          latitude: -36.1,
          longitude: 146.9,
          usualTransportMode: "plane"
        }
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("round-trips the user's default transport mode, absence-means-no-opinion on later saves", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { defaultTransportMode: "walk" }
    });
    expect(state.settings.defaultTransportMode).toBe("walk");
    // A later settings save silent about the field must not reset it.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { arrivalMarginMinutes: 5 }
    });
    expect(state.settings.defaultTransportMode).toBe("walk");
    expect(state.settings.arrivalMarginMinutes).toBe(5);
  });

  it("stores currentSituation.travelOff and refuses an explicitly emptied transportModes", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.currentSituation.travelOff).toBe(false);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "current_availability",
      entity: {
        currentEnergy: state.currentEnergy,
        assertedConditions: state.assertedConditions,
        currentSituation: { travelOff: true }
      }
    });
    expect(state.currentSituation.travelOff).toBe(true);
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "current_availability",
        entity: {
          currentEnergy: state.currentEnergy,
          assertedConditions: state.assertedConditions,
          currentSituation: { transportModes: [] }
        }
      })
    ).rejects.toThrow(InvalidCommandError);
    // The refusal did not half-apply anything: transportModes is still whatever it was.
    const after = (await store.get())!;
    expect(after.currentSituation.transportModes.length).toBeGreaterThan(0);
  });

  it("saves an occurrence's latenessMatters/transportMode and detaches it from the series overlay", async () => {
    await store.put(createSeedState(fixedNow));
    const ruleId = crypto.randomUUID();
    let state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: ruleId,
        title: "Weekly class",
        timezone: "Australia/Sydney",
        startDate: new Date(fixedNow.getTime() + 3 * 86_400_000).toISOString().slice(0, 10),
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "08:00",
        localEndTime: "09:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0,
        latenessMatters: true,
        transportMode: "car"
      }
    });
    const occurrence = state.commitments.find((item) => item.recurrenceRuleId === ruleId)!;
    expect(occurrence.latenessMatters).toBe(true);
    expect(occurrence.transportMode).toBe("car");
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: occurrence.version ?? null,
      type: "save_entity",
      entityType: "commitment",
      entity: { ...occurrence, latenessMatters: false, transportMode: "bike" }
    });
    const edited = state.commitments.find((item) => item.id === occurrence.id)!;
    expect(edited.latenessMatters).toBe(false);
    expect(edited.transportMode).toBe("bike");
    const rows = await sql<{ schedule_source: string }[]>`
      SELECT schedule_source FROM commitments WHERE id=${occurrence.id}
    `;
    expect(rows[0]?.schedule_source).toBe("custom");
  });

  it("saves latenessMatters/transportMode on a recurrence rule and its materialised occurrences", async () => {
    await store.put(createSeedState(fixedNow));
    const ruleId = crypto.randomUUID();
    let state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      rule: {
        id: ruleId,
        title: "Gym",
        timezone: "Australia/Sydney",
        startDate: new Date(fixedNow.getTime() + 3 * 86_400_000).toISOString().slice(0, 10),
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "18:00",
        localEndTime: "19:00",
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }
    });
    const rule = state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!;
    // The column's own default (true), not left unset: a fresh insert with no opinion still gets one.
    expect(rule.latenessMatters).toBe(true);
    expect(rule.transportMode).toBeUndefined();
    state = await store.saveCommitmentRecurrenceRule({
      commandId: crypto.randomUUID(),
      expectedVersion: rule.version ?? null,
      rule: { ...rule, latenessMatters: false, transportMode: "bike" }
    });
    const updatedRule = state.commitmentRecurrenceRules.find((item) => item.id === ruleId)!;
    expect(updatedRule.latenessMatters).toBe(false);
    expect(updatedRule.transportMode).toBe("bike");
    const occurrence = state.commitments.find((item) => item.recurrenceRuleId === ruleId)!;
    expect(occurrence.latenessMatters).toBe(false);
    expect(occurrence.transportMode).toBe("bike");
  });
});
