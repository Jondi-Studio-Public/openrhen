// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredDeliverable } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { BlockerRail } from "./blocker-rail";
import { blocker, deliverable, step } from "@/features/deliverables/test-fixtures";

const plan = deliverable({
  steps: [step("draft", { title: "Draft" }), step("submit", { title: "Submit" })],
  blockers: [blocker("portal", { description: "Portal closed", stepIds: ["submit"], proposedResolution: "Ask tutor" })]
});
const applied = (onEdit: ReturnType<typeof vi.fn>) =>
  onEdit.mock.calls.reduce<StoredDeliverable>((current, [change]) => change(current), plan);

describe("BlockerRail", () => {
  it("counts only open blockers and authors category, scope, state and resolution", () => {
    const onEdit = vi.fn();
    render(<BlockerRail deliverable={plan} editable onEdit={onEdit} />);
    expect(screen.getByRole("heading", { name: "Blockers" }).nextElementSibling?.textContent).toBe("1");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "waiting_on_someone" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "resolved" } });
    fireEvent.change(screen.getByLabelText("Resolution notes"), { target: { value: "Reopened Monday" } });
    const next = applied(onEdit).blockers[0]!;
    expect(next).toMatchObject({
      category: "waiting_on_someone",
      state: "resolved",
      resolutionNotes: "Reopened Monday"
    });
    expect(next.resolvedAt).toBeDefined();
  });

  it("records and removes a blocker", () => {
    const onEdit = vi.fn();
    render(<BlockerRail deliverable={plan} editable onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Record blocker" }));
    expect(applied(onEdit).blockers).toHaveLength(2);
    onEdit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Remove blocker" }));
    expect(applied(onEdit).blockers).toHaveLength(0);
  });

  it("reads as text when not editable", () => {
    render(<BlockerRail deliverable={plan} editable={false} onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "Record blocker" })).toBeNull();
    expect(screen.getByText("Blocks Submit")).toBeTruthy();
    expect(screen.getByText("Proposed: Ask tutor")).toBeTruthy();
  });
});
