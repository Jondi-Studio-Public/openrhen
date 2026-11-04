import { describe, expect, it } from "vitest";
import { normalizePlanningSlots, planSchedule, slotCapacityForAction } from "../../src/index.js";
import type { Action, CapacityWindow, Project } from "../../src/index.js";

/**
 * Finding 17: a slot's remaining capacity (what seeds the allocation ledger in schedule.ts) and
 * `slotCapacityForAction` (what an individual action can draw from a slot) used to disagree whenever
 * two capacity windows overlapped with different usable fractions, because the ledger was seeded from
 * whichever window won the display tie-break (highest energy rank) rather than from the true ceiling —
 * the best usable fraction any compatible action could reach. See the comment on `usableFraction` in
 * `normalizePlanningSlots` (slots.ts) for the fixed definition.
 */

const now = new Date("2026-08-10T00:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function action(id: string, energy: Action["energy"], overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId: "project",
    title: id,
    status: "active",
    expectedMinutes: 30,
    remainingMinutes: 30,
    pessimisticMinutes: 30,
    energy,
    minimumSessionMinutes: 5,
    maximumSessionMinutes: 30,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependenciesComplete: true,
    splittable: true,
    ...overrides
  };
}

function project(id: string, deadlineMinutes: number): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
    // An explicit internal deadline is used as-is (no submission buffer subtracted, unlike a
    // deadline derived from `externalDeadlineAt`), so the deadline lands exactly at the horizon end.
    internalDeadlineAt: at(deadlineMinutes),
    value: 3,
    consequence: 3
  };
}

// A narrow, high-energy window (wins the display tie-break) overlapping a wider, lower-energy one
// with a much higher usable fraction. Any low- or medium-energy action is compatible with both.
const narrowHigh: CapacityWindow = {
  id: "narrow-high",
  startsAt: now,
  endsAt: at(60),
  energy: "high",
  usableFraction: 0.2
};
const wideMedium: CapacityWindow = {
  id: "wide-medium",
  startsAt: now,
  endsAt: at(60),
  energy: "medium",
  usableFraction: 0.9
};

describe("slot capacity ceiling under overlapping windows", () => {
  it("uses the best usable fraction among compatible windows, not the display tie-break winner's own fraction", () => {
    const slots = normalizePlanningSlots({
      from: now,
      until: at(60),
      capacityWindows: [narrowHigh, wideMedium],
      commitments: []
    });
    // normalizePlanningSlots always cuts the horizon into quarter-hours, so both windows spanning
    // the full hour produce four identical 15-minute slots.
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      // The display tie-break still prefers the higher-energy window.
      expect(slot.energy).toBe("high");
      // But the capacity ceiling reflects the wider window's higher fraction, not the narrow one's 0.2.
      expect(slot.capacityMinutes).toBe(13.5); // 15 * 0.9
      const mediumAction = action("medium-action", "medium");
      expect(slotCapacityForAction(slot, mediumAction)).toBe(13.5);
      // The ledger the allocator seeds from and the per-action ceiling now agree.
      expect(slot.capacityMinutes).toBe(slotCapacityForAction(slot, mediumAction));
    }
  });

  it("is independent of the order the overlapping windows are supplied in", () => {
    const forward = normalizePlanningSlots({
      from: now,
      until: at(60),
      capacityWindows: [narrowHigh, wideMedium],
      commitments: []
    });
    const reversed = normalizePlanningSlots({
      from: now,
      until: at(60),
      capacityWindows: [wideMedium, narrowHigh],
      commitments: []
    });
    expect(forward[0]!.capacityMinutes).toBe(reversed[0]!.capacityMinutes);
  });
});

describe("consume against the slot ledger", () => {
  it("leaves the same total remaining regardless of which project is scheduled first", () => {
    // planSchedule processes projects in a canonical order (deadline, then id) regardless of the
    // order they are passed in, so the only way to genuinely flip *which* project goes first is to
    // give each demand a different id across the two runs — whichever id sorts first is the one that
    // is processed, and so consumes the ledger, first.
    const build = (firstId: string, secondId: string) =>
      planSchedule({
        now,
        horizonEnd: at(15),
        projects: [project(firstId, 15), project(secondId, 15)],
        actions: [
          action(`${firstId}-action`, "low", {
            projectId: firstId,
            remainingMinutes: 10,
            minimumSessionMinutes: 1,
            // Pinned so the PERT estimate collapses to exactly `remainingMinutes`, bypassing the
            // "known" uncertainty multiplier that would otherwise inflate the risk-adjusted demand
            // this test reasons about.
            optimisticMinutes: 10,
            expectedMinutes: 10,
            pessimisticMinutes: 10
          }),
          action(`${secondId}-action`, "low", {
            projectId: secondId,
            remainingMinutes: 10,
            minimumSessionMinutes: 1,
            optimisticMinutes: 10,
            expectedMinutes: 10,
            pessimisticMinutes: 10
          })
        ],
        capacityWindows: [
          { ...narrowHigh, endsAt: at(15) },
          { ...wideMedium, endsAt: at(15) }
        ],
        commitments: []
      });
    // Ledger capacity for this single 15-minute slot is 15 * 0.9 = 13.5 minutes, less than the 20
    // minutes jointly demanded, so which project goes first decides who gets the shortfall — but not
    // how much total capacity is left over once both have taken what they could.
    const xFirst = build("1-x", "2-y");
    const yFirst = build("2-x", "1-y");
    const totalConsumed = (result: typeof xFirst) => result.allocations.reduce((sum, block) => sum + block.minutes, 0);
    expect(totalConsumed(xFirst)).toBeCloseTo(13.5, 9);
    expect(totalConsumed(yFirst)).toBeCloseTo(13.5, 9);
    expect(totalConsumed(xFirst)).toBeCloseTo(totalConsumed(yFirst), 9);
    // The two runs must actually have exercised different processing order — otherwise the test would
    // not distinguish "same total" from "same everything".
    const minutesFor = (result: typeof xFirst, projectId: string) =>
      result.allocations
        .filter((block) => block.projectId === projectId)
        .reduce((sum, block) => sum + block.minutes, 0);
    // Each 10-minute single figure is reserved at its padded 12 (11.5 rounded up), so the first takes 12 and
    // the second the 1.5 left of the 13.5.
    expect(minutesFor(xFirst, "1-x")).toBeCloseTo(12, 9);
    expect(minutesFor(xFirst, "2-y")).toBeCloseTo(1.5, 9);
    expect(minutesFor(yFirst, "1-y")).toBeCloseTo(12, 9);
    expect(minutesFor(yFirst, "2-x")).toBeCloseTo(1.5, 9);
  });

  it("never lets a consume larger than the remainder push the ledger negative", () => {
    const hungry = project("hungry", 15);
    const result = planSchedule({
      now,
      horizonEnd: at(15),
      projects: [hungry],
      actions: [
        action("hungry-action", "low", { projectId: "hungry", remainingMinutes: 10_000, minimumSessionMinutes: 1 })
      ],
      capacityWindows: [
        { ...narrowHigh, endsAt: at(15) },
        { ...wideMedium, endsAt: at(15) }
      ],
      commitments: []
    });
    const consumed = result.allocations.reduce((sum, block) => sum + block.minutes, 0);
    const capacity = result.slots.reduce((sum, slot) => sum + slot.capacityMinutes, 0);
    expect(consumed).toBeCloseTo(capacity, 9);
    expect(consumed).toBeLessThanOrEqual(capacity + 1e-9);
  });

  it("does not accumulate rounding drift over many small consumes of a fractional-usable-fraction slot", () => {
    const third: CapacityWindow = { id: "third", startsAt: now, endsAt: at(15), energy: "low", usableFraction: 1 / 3 };
    const projects: Project[] = [];
    const actions: Action[] = [];
    for (let i = 0; i < 50; i += 1) {
      const id = `p${i}`;
      projects.push(project(id, 15));
      actions.push(action(`${id}-action`, "low", { projectId: id, remainingMinutes: 0.2, minimumSessionMinutes: 0.1 }));
    }
    const result = planSchedule({
      now,
      horizonEnd: at(15),
      projects,
      actions,
      capacityWindows: [third],
      commitments: []
    });
    const consumed = result.allocations.reduce((sum, block) => sum + block.minutes, 0);
    const capacity = result.slots.reduce((sum, slot) => sum + slot.capacityMinutes, 0);
    // 50 actions each asking for 0.2 minutes demand 10 total, comfortably above the ~5-minute ledger
    // (15 * 1/3), so consumption saturates the ledger. It must saturate it exactly — not overshoot from
    // accumulated float error, and not fall meaningfully short by leaving unconsumed capacity behind.
    expect(consumed).toBeCloseTo(capacity, 9);
    expect(consumed).toBeLessThanOrEqual(capacity + 1e-9);
  });
});
