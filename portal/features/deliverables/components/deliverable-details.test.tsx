// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredDeliverable } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { DeliverableDetails } from "./deliverable-details";
import { deliverable } from "@/features/deliverables/test-fixtures";

const others = [deliverable(), deliverable({ id: "assessment-1", title: "Assessment 1" })];
const projects = [{ id: "networking", title: "Networking unit" }] as never;
const applied = (onEdit: ReturnType<typeof vi.fn>) =>
  onEdit.mock.calls.reduce<StoredDeliverable>((current, [change]) => change(current), deliverable());

describe("DeliverableDetails", () => {
  it("authors both deadlines, weight, uncertainty and prerequisite deliverables", () => {
    const onEdit = vi.fn();
    render(
      <DeliverableDetails
        deliverable={deliverable()}
        others={others}
        projects={projects}
        timezone="Australia/Sydney"
        editable
        onEdit={onEdit}
      />
    );
    fireEvent.change(screen.getByLabelText("External deadline"), { target: { value: "2026-09-01T17:00" } });
    fireEvent.change(screen.getByLabelText("Internal deadline"), { target: { value: "2026-08-28T17:00" } });
    fireEvent.change(screen.getByLabelText("Uncertainty"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Importance (1–5)"), { target: { value: "9" } });
    // Folded shut, the picker's summary states that nothing is selected; the candidates sit in a
    // per-project group.
    const picker = screen.getByRole("group", { name: "Must finish first" });
    expect(picker.querySelector("summary")?.textContent).toContain("None selected — nothing blocks this deliverable.");
    expect(screen.getByText("Networking unit")).toBeTruthy();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Assessment 1" }));
    const next = applied(onEdit);
    // The inputs are wall-clock times in the deliverable's timezone, not the machine's: 17:00 in
    // seed-zone before daylight saving (UTC+10) is 07:00Z.
    expect(next.externalDeadlineAt).toBe("2026-09-01T07:00:00.000Z");
    expect(next.internalDeadlineAt).toBe("2026-08-28T07:00:00.000Z");
    expect(next.uncertainty).toBe("high");
    expect(next.importance).toBe(5);
    expect(next.dependencyIds).toEqual(["assessment-1"]);
  });

  it("reads as text when not editable", () => {
    render(
      <DeliverableDetails
        deliverable={deliverable({ dependencyIds: ["assessment-1"] })}
        others={others}
        projects={projects}
        timezone="Australia/Sydney"
        editable={false}
        onEdit={() => {}}
      />
    );
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.getByText("External deadline: none")).toBeTruthy();
    expect(screen.getByText("After Assessment 1")).toBeTruthy();
  });
});
