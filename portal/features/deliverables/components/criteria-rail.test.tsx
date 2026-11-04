// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredDeliverable } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { CriteriaRail } from "./criteria-rail";
import { criterion, deliverable, step } from "@/features/deliverables/test-fixtures";

const plan = deliverable({
  steps: [step("draft", { title: "Draft" })],
  criteria: [
    criterion("connectivity", { title: "Connectivity shown", stepIds: ["draft"], expectedEvidence: "Screenshot" }),
    criterion("style", { title: "Style guide followed", required: false, state: "uncertain" })
  ]
});
const applied = (onEdit: ReturnType<typeof vi.fn>) =>
  onEdit.mock.calls.reduce<StoredDeliverable>((current, [change]) => change(current), plan);

describe("CriteriaRail", () => {
  it("offers every contract state, the required flag, evidence and verification", () => {
    const onEdit = vi.fn();
    render(<CriteriaRail deliverable={plan} editable onEdit={onEdit} />);
    const states = screen.getAllByLabelText("State")[0] as HTMLSelectElement;
    expect([...states.options].map((option) => option.value)).toEqual([
      "unsatisfied",
      "satisfied",
      "uncertain",
      "not_applicable"
    ]);
    fireEvent.change(states, { target: { value: "not_applicable" } });
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Required for completion" })[0]!);
    fireEvent.change(screen.getAllByLabelText("Verification method")[0]!, { target: { value: "submission_receipt" } });
    fireEvent.change(screen.getAllByLabelText("Expected evidence")[0]!, { target: { value: "Receipt email" } });
    expect(applied(onEdit).criteria[0]).toMatchObject({
      state: "not_applicable",
      required: false,
      verificationMethod: "submission_receipt",
      expectedEvidence: "Receipt email"
    });
  });

  it("removes a criterion", () => {
    const onEdit = vi.fn();
    render(<CriteriaRail deliverable={plan} editable onEdit={onEdit} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove criterion" })[1]!);
    expect(applied(onEdit).criteria.map((item) => item.id)).toEqual(["connectivity"]);
  });

  it("reads as text when not editable, naming the steps and evidence", () => {
    render(<CriteriaRail deliverable={plan} editable={false} onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "Add criterion" })).toBeNull();
    expect(screen.getByText("Made true by Draft")).toBeTruthy();
    expect(screen.getByText("No action makes this true yet")).toBeTruthy();
    expect(screen.getByText(/Evidence: Screenshot/)).toBeTruthy();
    expect(screen.getByText(/· uncertain · optional/)).toBeTruthy();
  });
});
