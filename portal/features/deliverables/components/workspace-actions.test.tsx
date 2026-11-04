// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { WorkspaceActions } from "./workspace-actions";
import { assess, criterion, deliverable, step } from "@/features/deliverables/test-fixtures";

const handlers = { onSave: vi.fn(), onApprove: vi.fn(), onBeginReview: vi.fn(), onMarkComplete: vi.fn() };

describe("WorkspaceActions", () => {
  it("keeps Approve disabled while coverage fails and says why", () => {
    const plan = deliverable({
      contractApprovedAt: undefined,
      planApprovedAt: undefined,
      steps: [step("a")],
      criteria: [criterion("c")]
    });
    render(
      <WorkspaceActions
        deliverable={plan}
        readiness={assess(plan)}
        phase="Breakdown"
        dirty={false}
        saving={false}
        {...handlers}
      />
    );
    const approve = screen.getByRole("button", { name: /Approve breakdown/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toContain("coverage problems");
  });

  it("enables Approve once the contract is covered and saved", () => {
    const plan = deliverable({
      contractApprovedAt: undefined,
      planApprovedAt: undefined,
      steps: [step("a")],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    render(
      <WorkspaceActions
        deliverable={plan}
        readiness={assess(plan)}
        phase="Breakdown"
        dirty={false}
        saving={false}
        {...handlers}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve breakdown/ }));
    expect(handlers.onApprove).toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Begin Review only when every required step is finished, and Mark complete only when satisfied", () => {
    const open = deliverable({ steps: [step("a")], criteria: [criterion("c", { stepIds: ["a"] })] });
    const { unmount } = render(
      <WorkspaceActions
        deliverable={open}
        readiness={assess(open)}
        phase="Carry out"
        dirty={false}
        saving={false}
        {...handlers}
      />
    );
    expect((screen.getByRole("button", { name: "Begin Review" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const done = deliverable({
      status: "under_review",
      steps: [step("a", { status: "done" })],
      criteria: [criterion("c", { stepIds: ["a"], state: "satisfied" })]
    });
    render(
      <WorkspaceActions
        deliverable={done}
        readiness={assess(done)}
        phase="Review"
        dirty={false}
        saving={false}
        {...handlers}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark deliverable complete" }));
    expect(handlers.onMarkComplete).toHaveBeenCalled();
  });

  it.each(["archived", "cancelled"] as const)("does not let a %s required step disable Begin Review", (closed) => {
    const plan = deliverable({
      steps: [step("a", { status: "done" }), step("b", { status: closed })],
      criteria: [criterion("c", { stepIds: ["a"] })]
    });
    render(
      <WorkspaceActions
        deliverable={plan}
        readiness={assess(plan)}
        phase="Carry out"
        dirty={false}
        saving={false}
        {...handlers}
      />
    );
    expect((screen.getByRole("button", { name: "Begin Review" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
