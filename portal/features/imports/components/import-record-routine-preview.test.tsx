// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { ImportRecordRoutinePreview } from "./import-record-routine-preview";
import type { PortalState } from "@/state/portal-state";

const steps = [
  { id: "step-1", title: "Pack bag", durationMinutes: 10, timingRule: "contiguous", energy: "low", contexts: ["home"] },
  { id: "step-2", title: "Travel", durationMinutes: 25, timingRule: "contiguous", energy: "low", contexts: [] }
];

const routinePresets = [
  { id: "preset-1", name: "Leave for campus", status: "active", steps: [] },
  { id: "preset-2", name: "Retired routine", status: "archived", steps: [] }
] as unknown as PortalState["routinePresets"];

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "example_shared:event:1",
    entityType: "fixed_commitment",
    operation: "update",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {},
    relationships: { routinePresetId: "preset-1", routineSteps: JSON.stringify(steps) },
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const props = {
  conditionCatalog: ["home", "laptop"],
  routinePresets,
  selectRoutine: vi.fn(),
  patchRoutineSteps: vi.fn()
};

describe("ImportRecordRoutinePreview", () => {
  it("offers active presets plus whichever one this record already uses", () => {
    render(
      <ImportRecordRoutinePreview {...props} record={record({ relationships: { routinePresetId: "preset-2" } })} />
    );
    expect([...screen.getByRole("combobox").querySelectorAll("option")].map((item) => item.textContent)).toEqual([
      "None",
      "Leave for campus",
      "Retired routine"
    ]);
  });

  it("reports a changed preset selection", () => {
    const selectRoutine = vi.fn();
    render(<ImportRecordRoutinePreview {...props} record={record()} selectRoutine={selectRoutine} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(selectRoutine).toHaveBeenCalledWith("record-1", "");
  });

  it("renames a step without touching the others", () => {
    const patchRoutineSteps = vi.fn();
    render(<ImportRecordRoutinePreview {...props} record={record()} patchRoutineSteps={patchRoutineSteps} />);
    fireEvent.change(screen.getByDisplayValue("Pack bag"), { target: { value: "Pack laptop" } });
    expect(patchRoutineSteps).toHaveBeenCalledWith("record-1", [
      { ...steps[0], title: "Pack laptop" },
      { ...steps[1] }
    ]);
  });

  it("reads a duration as a number", () => {
    const patchRoutineSteps = vi.fn();
    render(<ImportRecordRoutinePreview {...props} record={record()} patchRoutineSteps={patchRoutineSteps} />);
    fireEvent.change(screen.getByDisplayValue("25"), { target: { value: "30" } });
    expect(patchRoutineSteps.mock.calls[0]![1][1].durationMinutes).toBe(30);
  });

  it("drops the step the user removed", () => {
    const patchRoutineSteps = vi.fn();
    render(<ImportRecordRoutinePreview {...props} record={record()} patchRoutineSteps={patchRoutineSteps} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove step" })[0]!);
    expect(patchRoutineSteps).toHaveBeenCalledWith("record-1", [steps[1]]);
  });

  it("shows no steps when the record carries none", () => {
    render(<ImportRecordRoutinePreview {...props} record={record({ relationships: {} })} />);
    expect(screen.queryByRole("button", { name: "Remove step" })).toBeNull();
  });
});
