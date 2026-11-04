// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import type { PortalState } from "@/state/portal-state";
import { emptyAction } from "@/features/plan/plan-drafts";
import { ActionContextFields } from "@/features/plan/components/action-context-fields";

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
const conditionDefinitions: ConditionDefinition[] = [
  context("home", "At home"),
  context("outdoors", "Outdoors"),
  context("old-desk", "Old desk", "archived")
];
const draft = () => ({ ...emptyAction("Australia/Sydney"), pathways: [["home"]] });

/**
 * Each route and the preference list are separate lists inside the group, so a box is reached by its
 * own accessible name within the route it belongs to.
 */
const boxFor = (scope: HTMLElement, name: string) => within(scope).getByRole("checkbox", { name });
const routes = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".pathway-route"));
const preferences = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".choice-list")).at(-1)!;

describe("ActionContextFields", () => {
  it("names each group and leaves every checkbox its own name", () => {
    const { container } = render(
      <ActionContextFields draft={draft()} conditionDefinitions={conditionDefinitions} onChange={() => {}} />
    );
    expect(screen.getByRole("group", { name: "Where can this be done?" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Prefers, but does not need" })).toBeTruthy();
    expect(within(routes(container)[0]!).getByRole("checkbox", { name: "At home" })).toBeTruthy();
    expect(within(preferences(container)).getByRole("checkbox", { name: "Outdoors" })).toBeTruthy();
  });

  it("leaves archived contexts out of both lists", () => {
    render(<ActionContextFields draft={draft()} conditionDefinitions={conditionDefinitions} onChange={() => {}} />);
    expect(screen.queryByText("Old desk")).toBeNull();
    expect(screen.getAllByText("At home")).toHaveLength(2);
  });

  it("adds a second way of doing the work and says any one of them is enough", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ActionContextFields draft={draft()} conditionDefinitions={conditionDefinitions} onChange={onChange} />
    );
    expect(screen.queryByText("Any one of these is enough")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add another way to do this" }));
    expect(onChange).toHaveBeenCalledWith({ ...draft(), pathways: [["home"], []] });
    rerender(
      <ActionContextFields
        draft={{ ...draft(), pathways: [["home"], []] }}
        conditionDefinitions={conditionDefinitions}
        onChange={onChange}
      />
    );
    expect(screen.getByText("Any one of these is enough")).toBeTruthy();
    expect(screen.getByText("Or this needs")).toBeTruthy();
    expect(routes(container)).toHaveLength(2);
    expect(screen.getByText("Nothing ticked, so this way places no requirement at all.")).toBeTruthy();
  });

  it("ticks a requirement into the route it was ticked in, not the others", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ActionContextFields
        draft={{ ...draft(), pathways: [["home"], []] }}
        conditionDefinitions={conditionDefinitions}
        onChange={onChange}
      />
    );
    fireEvent.click(boxFor(routes(container)[1]!, "Outdoors"));
    expect(onChange).toHaveBeenCalledWith({ ...draft(), pathways: [["home"], ["outdoors"]] });
  });

  it("unticks a requirement without touching the other route", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ActionContextFields
        draft={{ ...draft(), pathways: [["home"], ["home", "outdoors"]] }}
        conditionDefinitions={conditionDefinitions}
        onChange={onChange}
      />
    );
    fireEvent.click(boxFor(routes(container)[1]!, "At home"));
    expect(onChange).toHaveBeenCalledWith({ ...draft(), pathways: [["home"], ["outdoors"]] });
  });

  it("removes a way of doing the work only when there is more than one", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ActionContextFields draft={draft()} conditionDefinitions={conditionDefinitions} onChange={onChange} />
    );
    expect(container.querySelectorAll("button.danger")).toHaveLength(0);
    rerender(
      <ActionContextFields
        draft={{ ...draft(), pathways: [["home"], ["outdoors"]] }}
        conditionDefinitions={conditionDefinitions}
        onChange={onChange}
      />
    );
    const removals = container.querySelectorAll<HTMLButtonElement>("button.danger");
    expect(removals).toHaveLength(2);
    fireEvent.click(removals[1]!);
    expect(onChange).toHaveBeenCalledWith({ ...draft(), pathways: [["home"]] });
  });

  it("keeps a preference separate from a requirement", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ActionContextFields draft={draft()} conditionDefinitions={conditionDefinitions} onChange={onChange} />
    );
    fireEvent.click(boxFor(preferences(container), "At home"));
    expect(onChange).toHaveBeenCalledWith({ ...draft(), preferences: ["home"] });
  });
});
