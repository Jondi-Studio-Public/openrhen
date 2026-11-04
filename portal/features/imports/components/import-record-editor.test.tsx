// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { ImportRecordEditor } from "./import-record-editor";
import type { PortalState } from "@/state/portal-state";

const steps = [
  {
    id: "step-1",
    title: "Pack bag",
    durationMinutes: 10,
    timingRule: "contiguous",
    energy: "low",
    contexts: [],
    sequence: 0,
    phase: "before",
    dependencyIds: []
  }
];

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "example_shared:event:42",
    entityType: "fixed_commitment",
    operation: "update",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {
      title: { value: "Class", basis: "explicit", confidence: "high", evidence: [], needsReview: false }
    },
    relationships: { example_sharedEventId: "42", routineSteps: JSON.stringify(steps) },
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const actions = {
  conditionCatalog: ["home"],
  places: [] as unknown as PortalState["conditionDefinitions"],
  routinePresets: [] as unknown as PortalState["routinePresets"],
  timeBands: [],
  updateField: vi.fn(),
  applyLocation: vi.fn(),
  createCustomLocation: vi.fn(),
  selectRoutine: vi.fn(),
  patchRoutineSteps: vi.fn(),
  updateRelationship: vi.fn(),
  resolveCalendarConflict: vi.fn(),
  applyDefault: vi.fn(),
  toggleRemoved: vi.fn(),
  acceptOverlap: vi.fn(),
  acceptCancel: vi.fn(),
  resolveSourceMatch: vi.fn(),
  dropCommitment: vi.fn()
};

describe("ImportRecordEditor", () => {
  it("presents a calendar record as a tick that is on while the record is kept", () => {
    const toggleRemoved = vi.fn();
    const { container } = render(<ImportRecordEditor {...actions} record={record()} toggleRemoved={toggleRemoved} />);
    const selector = container.querySelector<HTMLInputElement>(".calendar-event-selector input")!;
    expect(selector.checked).toBe(true);
    expect(screen.getByText("Event selected")).toBeTruthy();
    fireEvent.click(selector);
    expect(toggleRemoved).toHaveBeenCalledWith("record-1");
  });

  it("explains that an unticked event will not be imported", () => {
    render(<ImportRecordEditor {...actions} record={record({ removed: true })} />);
    expect(screen.getByText("Select event")).toBeTruthy();
    expect(screen.getByText("This event will not be imported.")).toBeTruthy();
  });

  it("gives a non-calendar record no selector at all", () => {
    const { container } = render(
      <ImportRecordEditor
        {...actions}
        record={record({ importKey: "action:one", entityType: "action", relationships: {} })}
      />
    );
    expect(container.querySelector(".calendar-event-selector")).toBeNull();
    expect(container.querySelector(".calendar-event-record")).toBeNull();
  });

  it("summarises the carried routine and opens the one-off editor for this event only", () => {
    render(<ImportRecordEditor {...actions} record={record()} />);
    expect(screen.getByText("1 tile selected · preset remains unchanged")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit for this event" }));
    expect(screen.getByRole("dialog").textContent).toContain("Edit routine for Class");
  });

  it("saves the one-off steps back onto the record and closes the editor", () => {
    const patchRoutineSteps = vi.fn();
    render(<ImportRecordEditor {...actions} record={record()} patchRoutineSteps={patchRoutineSteps} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit for this event" }));
    fireEvent.click(screen.getByRole("button", { name: "Use for this event" }));
    expect(patchRoutineSteps).toHaveBeenCalledWith("record-1", [expect.objectContaining({ title: "Pack bag" })]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
