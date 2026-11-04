// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { fireEvent, render, screen, within } from "@/test/render";
import { DirectionPanel } from "./direction-panel";

const state = {
  areas: [{ id: "study", name: "Study", status: "active", sortOrder: 0 }],
  outcomes: [{ id: "degree", areaId: "study", title: "Finish semester", value: 5, status: "active" }],
  projects: [{ id: "essay", outcomeId: "degree", title: "History essay", status: "active" }],
  actions: [
    { id: "outline", projectId: "essay", title: "Outline the essay", status: "planned" },
    { id: "draft", projectId: "essay", title: "Draft the essay", status: "done" },
    { id: "stray", projectId: "missing-project", title: "Unfiled errand", status: "planned" }
  ],
  dailyPlan: {
    localDate: "2026-08-18",
    desiredActionIds: ["outline"],
    deferredItems: [{ actionId: "stray", reason: "no car today" }]
  }
} as unknown as PortalState;

const renderPanel = (overrides: Partial<Parameters<typeof DirectionPanel>[0]> = {}) =>
  render(
    <DirectionPanel
      state={state}
      desiredWins={["outline"]}
      onDesiredWinsChange={() => {}}
      deferredAction=""
      onDeferredActionChange={() => {}}
      deferredReason=""
      onDeferredReasonChange={() => {}}
      onSubmit={() => {}}
      {...overrides}
    />
  );

describe("Today direction panel", () => {
  it("holds the chosen wins against the maximum of three, with no heading of its own", () => {
    // The sheet that hosts the panel carries the title; the panel is only its content.
    const { rerender } = renderPanel();
    expect(screen.queryByRole("heading")).toBe(null);
    expect(screen.queryByText("Three wins is the maximum. Remove one to swap it for something else.")).toBe(null);
    rerender(
      <DirectionPanel
        state={state}
        desiredWins={["outline", "draft", "stray"]}
        onDesiredWinsChange={() => {}}
        deferredAction=""
        onDeferredActionChange={() => {}}
        deferredReason=""
        onDeferredReasonChange={() => {}}
        onSubmit={() => {}}
      />
    );
    expect(screen.getByText("Three wins is the maximum. Remove one to swap it for something else.")).toBeTruthy();
  });

  it("groups deferrable actions under their project, keeps unfiled ones loose, and hides finished work", () => {
    renderPanel();
    const select = screen.getByLabelText("Defer an action");
    expect(within(select).getByRole("group", { name: "History essay" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Outline the essay" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Unfiled errand" })).toBeTruthy();
    expect(within(select).queryByRole("option", { name: "Draft the essay" })).toBe(null);
  });

  it("reports a chosen deferral and its reason back to the page", () => {
    const onDeferredActionChange = vi.fn();
    const onDeferredReasonChange = vi.fn();
    renderPanel({ onDeferredActionChange, onDeferredReasonChange });
    fireEvent.change(screen.getByLabelText("Defer an action"), { target: { value: "stray" } });
    expect(onDeferredActionChange).toHaveBeenCalledWith("stray");
    fireEvent.change(screen.getByLabelText("Deferral reason"), { target: { value: "no car today" } });
    expect(onDeferredReasonChange).toHaveBeenCalledWith("no car today");
  });

  it("saves through the caller's submit handler and lists what was already deferred", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    renderPanel({ onSubmit });
    expect(screen.getByText("Deferred: Unfiled errand · no car today")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save today’s direction" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
