// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { PortalState } from "@/state/portal-state";
import { RequirementPathways } from "./requirement-pathways";

type ConditionDefinition = PortalState["conditionDefinitions"][number];
const context = (id: string, name: string, status: ConditionDefinition["status"] = "active"): ConditionDefinition => ({
  id,
  name,
  kind: "location",
  status,
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: []
});
const definitions = [context("home", "At home"), context("laptop", "Laptop"), context("old", "Old desk", "archived")];

describe("RequirementPathways", () => {
  it("reads the requirement in words when not editable", () => {
    render(
      <RequirementPathways
        pathways={[
          { id: "p1", contextIds: ["home", "laptop"] },
          { id: "p2", contextIds: ["laptop"] }
        ]}
        conditionDefinitions={definitions}
        editable={false}
        onChange={() => {}}
      />
    );
    expect(screen.getByText("Needs At home + Laptop, or Laptop")).toBeTruthy();
  });

  it("adds a way, ticks a context and leaves archived contexts out", () => {
    const onChange = vi.fn();
    render(<RequirementPathways pathways={[]} conditionDefinitions={definitions} editable onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a requirement" }));
    const added = onChange.mock.calls[0]![0];
    expect(added).toHaveLength(1);
    expect(added[0].contextIds).toEqual([]);
    onChange.mockClear();
    const { unmount } = render(
      <RequirementPathways pathways={added} conditionDefinitions={definitions} editable onChange={onChange} />
    );
    expect(screen.queryByText("Old desk")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Laptop" }));
    expect(onChange.mock.calls[0]![0][0].contextIds).toEqual(["laptop"]);
    unmount();
  });

  it("says any one way is enough once there are two", () => {
    render(
      <RequirementPathways
        pathways={[
          { id: "p1", contextIds: ["home"] },
          { id: "p2", contextIds: ["laptop"] }
        ]}
        conditionDefinitions={definitions}
        editable
        onChange={() => {}}
      />
    );
    expect(screen.getByText("Any one of these is enough")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove this way" })).toHaveLength(2);
  });
});
