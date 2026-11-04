// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { WorkspaceSheets } from "./workspace-sheets";
import { assess, deliverable, fixtureNow, session, step } from "@/features/deliverables/test-fixtures";

const plan = deliverable({ steps: [step("a", { title: "Draft" }), step("b", { title: "Polish" })] });
const readiness = assess(plan);

const base = {
  onClose: vi.fn(),
  deliverable: plan,
  readiness,
  engine: undefined,
  conditionDefinitions: [],
  projects: [],
  others: [],
  timezone: "Australia/Melbourne",
  editable: true,
  dirty: false,
  saving: false,
  onSaveStepRequirementPathways: vi.fn(async () => true),
  session: null,
  now: fixtureNow,
  currentStepTitle: undefined,
  canSwitch: false,
  planningDecisionCurrent: true,
  continuation: null,
  proposals: [],
  proposalDrafts: {},
  onEdit: vi.fn(),
  onSave: vi.fn(),
  onSwitchStep: vi.fn(),
  onAttach: vi.fn(async () => {}),
  onPauseResume: vi.fn(),
  onContinue: vi.fn(),
  onFinish: vi.fn(),
  onProposalChange: vi.fn(),
  onDecideProposal: vi.fn()
};

describe("WorkspaceSheets", () => {
  it("renders nothing when no drawer is open", () => {
    render(<WorkspaceSheets {...base} drawer={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders each drawer's panel behind a dialog named for it", () => {
    const cases: [Parameters<typeof WorkspaceSheets>[0]["drawer"], string, string][] = [
      ["details", "Details", "Deliverable details"],
      ["steps", "Actions", "Actions"],
      ["criteria", "Completion criteria", "Completion criteria"],
      ["sources", "Retained source files", "Sources"],
      ["blockers", "Blockers", "Blockers"],
      ["readiness", "Readiness", "Readiness"]
    ];
    for (const [drawer, title, marker] of cases) {
      const { unmount } = render(<WorkspaceSheets {...base} drawer={drawer} />);
      const dialog = screen.getByRole("dialog", { name: title });
      expect(dialog).toBeTruthy();
      expect(screen.getByRole("region", { name: marker })).toBeTruthy();
      unmount();
    }
  });

  it("renders the Session panel, or a fallback when no session is active", () => {
    render(<WorkspaceSheets {...base} drawer="session" />);
    expect(screen.getByText("No active session.")).toBeTruthy();
  });

  it("calls onClose from the dialog's close control", () => {
    const onClose = vi.fn();
    render(<WorkspaceSheets {...base} drawer="details" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("disables the save row until dirty, and saves from it", () => {
    const onSave = vi.fn();
    const { rerender } = render(<WorkspaceSheets {...base} drawer="details" onSave={onSave} dirty={false} />);
    expect(screen.getByText("Saved")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    rerender(<WorkspaceSheets {...base} drawer="details" onSave={onSave} dirty />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalled();
  });

  it("offers Close instead of a Save that could never enable when the view is read-only", () => {
    const onClose = vi.fn();
    render(<WorkspaceSheets {...base} drawer="steps" editable={false} onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("has no save row for sources or readiness", () => {
    render(<WorkspaceSheets {...base} drawer="sources" />);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("switching step in the Steps sheet calls onSwitchStep then onClose", () => {
    const onSwitchStep = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceSheets
        {...base}
        drawer="steps"
        canSwitch
        session={session({ stepId: "a" })}
        onSwitchStep={onSwitchStep}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Work on this action" }));
    expect(onSwitchStep).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalled();
  });
});
