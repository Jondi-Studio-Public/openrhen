// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { PhaseBar, type WorkspaceDrawer } from "./phase-bar";
import {
  assess,
  blocker,
  criterion,
  deliverable,
  fixtureNow,
  session,
  step
} from "@/features/deliverables/test-fixtures";

const base = {
  now: fixtureNow,
  currentStepTitle: "Draft",
  canSwitch: false,
  saving: false,
  planningDecisionCurrent: true,
  continuation: null,
  pendingProposalCount: 0,
  onPauseResume: vi.fn(),
  onContinue: vi.fn(),
  onOpen: vi.fn()
};

describe("PhaseBar", () => {
  it("shows the current step and countdown, and fires Pause", () => {
    const plan = deliverable({ steps: [step("draft", { title: "Draft" })] });
    const onPauseResume = vi.fn();
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Carry out"
        session={session({ stepId: "draft" })}
        onPauseResume={onPauseResume}
      />
    );
    expect(screen.getByText("Now: Draft")).toBeTruthy();
    expect(screen.getByText("20:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPauseResume).toHaveBeenCalled();
  });

  it("warns plainly when a running session has no step chosen", () => {
    const plan = deliverable({});
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Carry out"
        session={session()}
        currentStepTitle={undefined}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("not being credited to any action");
  });

  it("shows the Continue label and fires onContinue at the checkpoint", () => {
    const plan = deliverable({ steps: [step("draft", { title: "Draft" })] });
    const onContinue = vi.fn();
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Carry out"
        session={session({ status: "feedback", stepId: "draft", plannedEndAt: fixtureNow.toISOString() })}
        continuation={{ safe: true, recommendedMinutes: 25, reason: "Nothing is displaced.", displacedProjectIds: [] }}
        onContinue={onContinue}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue for 25 min" }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("names the coverage-failure count on the Breakdown chip and opens Readiness", () => {
    const plan = deliverable({
      contractApprovedAt: undefined,
      planApprovedAt: undefined,
      steps: [step("orphan", { title: "Orphan step" })],
      criteria: [criterion("bare", { title: "Bare criterion" })]
    });
    const onOpen = vi.fn();
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Breakdown"
        session={null}
        onOpen={onOpen}
      />
    );
    const chip = screen.getByRole("button", { name: /problems block approval/ });
    expect(chip.textContent).toContain("2 problems block approval");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("readiness");
  });

  it("counts only open blockers on the Blockers chip", () => {
    const plan = deliverable({
      blockers: [
        blocker("a", { state: "open" }),
        blocker("b", { state: "resolved" }),
        blocker("c", { state: "awaiting_response" })
      ]
    });
    render(<PhaseBar {...base} deliverable={plan} readiness={assess(plan)} phase="Carry out" session={null} />);
    expect(screen.getByRole("button", { name: "Blockers 2" })).toBeTruthy();
  });

  it("shows the timer and stop control in Breakdown phase when a session is running", () => {
    const plan = deliverable({
      contractApprovedAt: undefined,
      planApprovedAt: undefined,
      steps: [step("draft", { title: "Draft" })]
    });
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Breakdown"
        session={session({ stepId: "draft" })}
      />
    );
    // SessionFocus elements should be present
    expect(screen.getByText("Now: Draft")).toBeTruthy();
    expect(screen.getByText("20:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
    // BreakdownFocus elements should also be present (beside SessionFocus, not replacing it)
    expect(screen.getByText("Unapproved breakdown")).toBeTruthy();
  });

  it("calls onOpen with each chip's key", () => {
    const plan = deliverable({ steps: [step("a")], criteria: [criterion("c")] });
    const onOpen = vi.fn();
    render(
      <PhaseBar
        {...base}
        deliverable={plan}
        readiness={assess(plan)}
        phase="Carry out"
        session={session({ stepId: "a" })}
        pendingProposalCount={2}
        onOpen={onOpen}
      />
    );
    const keys: [string, WorkspaceDrawer][] = [
      ["Details", "details"],
      ["Actions 1", "steps"],
      ["Sources 0", "sources"],
      ["Readiness", "readiness"],
      ["Session", "session"],
      ["Earlier extraction 2", "proposals"]
    ];
    for (const [name, drawer] of keys) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(onOpen).toHaveBeenCalledWith(drawer);
    }
    fireEvent.click(screen.getByRole("button", { name: "Criteria 0/1" }));
    expect(onOpen).toHaveBeenCalledWith("criteria");
  });
});
