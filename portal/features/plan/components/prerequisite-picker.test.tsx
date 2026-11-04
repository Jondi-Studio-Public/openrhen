// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { PrerequisitePicker } from "@/features/plan/components/prerequisite-picker";
import type { PrerequisitePlan } from "@/features/plan/prerequisite-choices";

const plan = {
  projects: [{ id: "p1", title: "Thesis", status: "active" }],
  deliverables: [{ id: "d1", title: "Chapter", projectId: "p1", status: "ready", dependencyIds: [] }],
  actions: [
    { id: "a1", title: "Draft", projectId: "p1", status: "planned", dependencyIds: [] },
    { id: "a2", title: "Cite", projectId: "p1", status: "planned", dependencyIds: [] }
  ]
} as unknown as PrerequisitePlan;

describe("PrerequisitePicker", () => {
  it("writes same-kind choices to dependencyIds and the rest to prerequisites", () => {
    const onChange = vi.fn();
    render(
      <PrerequisitePicker
        self={{ kind: "action", id: "a1", projectId: "p1" }}
        plan={plan}
        dependencyIds={[]}
        prerequisites={[]}
        onChange={onChange}
      />
    );
    expect(screen.queryByRole("checkbox", { name: "Draft" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Cite" }));
    expect(onChange).toHaveBeenLastCalledWith({ dependencyIds: ["a2"], prerequisites: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Chapter" }));
    expect(onChange).toHaveBeenLastCalledWith({
      dependencyIds: [],
      prerequisites: [{ kind: "deliverable", id: "d1" }]
    });
  });
});
