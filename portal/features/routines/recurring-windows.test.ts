import { describe, expect, it } from "vitest";
import { cadenceActionOptions, recurringWindowOptions } from "@/features/routines/recurring-windows";
import type { PortalState } from "@/state/portal-state";

const action = (overrides: Record<string, unknown>) => overrides as PortalState["actions"][number];

describe("recurringWindowOptions", () => {
  it("names each window after the action it belongs to and carries its estimate", () => {
    const options = recurringWindowOptions([
      action({
        title: "Stretch",
        schedulingMode: "recurring",
        expectedMinutes: 15,
        recurrence: {
          windows: [
            { id: "morning", name: "Morning" },
            { id: "evening", name: "Evening" }
          ]
        }
      })
    ]);
    expect(options).toEqual([
      { id: "morning", label: "Stretch · Morning", minutes: 15 },
      { id: "evening", label: "Stretch · Evening", minutes: 15 }
    ]);
  });

  it("ignores one-off actions and recurring actions with no windows", () => {
    const options = recurringWindowOptions([
      action({
        title: "Essay",
        schedulingMode: "flexible",
        expectedMinutes: 60,
        recurrence: { windows: [{ id: "x" }] }
      }),
      action({ title: "Walk", schedulingMode: "recurring", expectedMinutes: 30 })
    ]);
    expect(options).toEqual([]);
  });
});

describe("cadenceActionOptions", () => {
  it("lists one option per cadence action, carrying its own estimate", () => {
    const options = cadenceActionOptions([
      action({ id: "a1", title: "Practice piano", schedulingMode: "cadence", expectedMinutes: 20 }),
      action({ id: "a2", title: "Stretch", schedulingMode: "cadence", expectedMinutes: 10 })
    ]);
    expect(options).toEqual([
      { id: "a1", label: "Practice piano", minutes: 20 },
      { id: "a2", label: "Stretch", minutes: 10 }
    ]);
  });

  it("ignores actions that are not scheduled as cadence", () => {
    const options = cadenceActionOptions([
      action({ id: "a1", title: "Essay", schedulingMode: "flexible", expectedMinutes: 60 }),
      action({ id: "a2", title: "Walk", schedulingMode: "recurring", expectedMinutes: 30 })
    ]);
    expect(options).toEqual([]);
  });
});
