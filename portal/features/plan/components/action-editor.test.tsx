// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { actionDraftFrom, emptyAction } from "@/features/plan/plan-drafts";
import { ActionEditor } from "@/features/plan/components/action-editor";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const SEED_ZONE = "Australia/Sydney";
const editor = (props: Partial<Parameters<typeof ActionEditor>[0]> = {}) => (
  <ActionEditor
    draft={emptyAction(SEED_ZONE)}
    projects={seed().projects}
    actions={seed().actions}
    conditionDefinitions={[]}
    onChange={() => {}}
    onSubmit={() => {}}
    onCancel={() => {}}
    {...props}
  />
);

describe("ActionEditor", () => {
  it("focuses the title when an existing action is opened for editing, not the project select", () => {
    render(editor({ draft: { ...emptyAction(SEED_ZONE), id: "room-floor", title: "Sort the bedroom floor" } }));
    expect(document.activeElement).toBe(screen.getByLabelText("Action title"));
  });

  it("leaves focus alone on a new action, where the project is the first thing to choose", () => {
    render(editor());
    expect(document.activeElement).not.toBe(screen.getByLabelText("Action title"));
  });

  it("hides the recurrence questions until the action is set to recur", () => {
    const { rerender } = render(editor());
    expect(screen.queryByLabelText("Series starts")).toBeNull();
    rerender(editor({ draft: { ...emptyAction(SEED_ZONE), schedulingMode: "recurring" } }));
    expect(screen.getByLabelText("Series starts")).toBeTruthy();
  });

  it("carries a new action's expected estimate into its remaining effort", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    fireEvent.change(screen.getByLabelText("Expected minutes"), { target: { value: "40" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyAction(SEED_ZONE), expectedMinutes: 40, remainingMinutes: 40 });
  });

  it("leaves the remaining effort alone when an existing action is re-estimated", () => {
    const onChange = vi.fn();
    const draft = { ...emptyAction(SEED_ZONE), id: "room-floor", remainingMinutes: 7 };
    render(editor({ draft, onChange }));
    fireEvent.change(screen.getByLabelText("Expected minutes"), { target: { value: "40" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, expectedMinutes: 40, remainingMinutes: 7 });
  });

  it("never offers an action itself as one of its own dependencies", () => {
    render(editor({ draft: { ...emptyAction(SEED_ZONE), id: "room-floor" } }));
    expect(screen.getByRole("checkbox", { name: "Draft networking assignment section 1" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Sort the bedroom floor" })).toBeNull();
  });

  it("says so plainly when there is nothing to depend on yet", () => {
    render(editor({ actions: [], projects: [] }));
    expect(screen.getByText("Nothing else to depend on yet.")).toBeTruthy();
  });

  it("ticks a dependency onto the draft", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sort the bedroom floor" }));
    expect(onChange).toHaveBeenCalledWith({ ...emptyAction(SEED_ZONE), dependencyIds: ["room-floor"] });
  });

  it("toggles Private when nothing above it is private", () => {
    const onChange = vi.fn();
    render(
      editor({
        onChange,
        draft: { ...emptyAction(SEED_ZONE), projectId: "clean-room" },
        outcomes: seed().outcomes,
        areas: seed().areas
      })
    );
    const checkbox = screen.getByLabelText<HTMLInputElement>("Private");
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ ...emptyAction(SEED_ZONE), projectId: "clean-room", private: true });
  });

  it("shows Private as inherited once the project is private", () => {
    const projects = seed().projects.map((project) =>
      project.id === "clean-room" ? { ...project, private: true } : project
    );
    render(
      editor({
        draft: { ...emptyAction(SEED_ZONE), projectId: "clean-room" },
        projects,
        outcomes: seed().outcomes,
        areas: seed().areas
      })
    );
    const checkbox = screen.getByLabelText<HTMLInputElement>("Private");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText("Private through Reset and clean my room.")).toBeTruthy();
  });
});

describe("ActionEditor: assumed values", () => {
  const stored = { ...seed().actions[0]!, assumedFields: ["expectedMinutes", "energy", "splittable"] };
  const editing = (draft = actionDraftFrom(stored, SEED_ZONE)) => editor({ draft, actions: [stored] });

  it("labels each field the stored action lists as assumed, and only those", () => {
    render(editing());
    expect(screen.getByLabelText("Expected minutes assumed")).toBeTruthy();
    expect(screen.getByLabelText("Energy assumed")).toBeTruthy();
    expect(screen.getByText("Splittable").parentElement?.textContent).toContain("assumed");
    expect(screen.getByLabelText("Pessimistic minutes")).toBeTruthy();
    expect(screen.getByLabelText("Importance (1–5)")).toBeTruthy();
    expect(screen.getAllByText("assumed")).toHaveLength(3);
  });

  it("drops the label from a field once its value is changed", () => {
    const draft = actionDraftFrom(stored, SEED_ZONE);
    const { rerender } = render(editing(draft));
    expect(screen.getByLabelText("Expected minutes assumed")).toBeTruthy();
    rerender(editing({ ...draft, expectedMinutes: draft.expectedMinutes + 10 }));
    expect(screen.queryByLabelText("Expected minutes assumed")).toBeNull();
    expect(screen.getByLabelText("Expected minutes")).toBeTruthy();
    expect(screen.getByLabelText("Energy assumed")).toBeTruthy();
  });

  it("labels nothing for a new action, or one that lists nothing", () => {
    const { rerender } = render(editor());
    expect(screen.queryByText("assumed")).toBeNull();
    const plain = seed().actions[0]!;
    rerender(editor({ draft: actionDraftFrom(plain, SEED_ZONE), actions: [plain] }));
    expect(screen.queryByText("assumed")).toBeNull();
  });
});
