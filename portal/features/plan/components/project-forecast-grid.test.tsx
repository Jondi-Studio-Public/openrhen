// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { deliverable } from "@/features/deliverables/test-fixtures";
import { ProjectForecastGrid } from "@/features/plan/components/project-forecast-grid";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));

describe("ProjectForecastGrid", () => {
  it("gives every project a card and matches each one to its own actions", () => {
    const state = seed();
    render(
      <ProjectForecastGrid
        projects={state.projects}
        actions={state.actions}
        forecasts={[]}
        projectEnvelopes={[]}
        timezone="Australia/Sydney"
        onEditProject={() => {}}
      />
    );
    expect(screen.getAllByRole("button", { name: "Edit project" })).toHaveLength(2);
    expect(screen.getByText("Draft networking assignment section 1")).toBeTruthy();
    expect(screen.getByText("Sort the bedroom floor")).toBeTruthy();
  });

  it("leaves finished actions out of the arithmetic but still lists them, marked done and reopenable", () => {
    const state = seed();
    const onEditAction = vi.fn();
    render(
      <ProjectForecastGrid
        projects={state.projects}
        actions={state.actions.map((item) => (item.id === "room-floor" ? { ...item, status: "done" as const } : item))}
        forecasts={[]}
        projectEnvelopes={[]}
        timezone="Australia/Sydney"
        onEditProject={() => {}}
        onEditAction={onEditAction}
      />
    );
    const roomCard = screen.getByText("Reset and clean my room").closest("article")!;
    // The disclosure count is over the non-done actions only: this project has none left.
    expect(within(roomCard).getByText("Actions (0)")).toBeTruthy();
    expect(within(roomCard).getByText(/done · 45 min/)).toBeTruthy();
    fireEvent.click(within(roomCard).getByRole("button", { name: "Edit" }));
    expect(onEditAction).toHaveBeenCalledWith(expect.objectContaining({ id: "room-floor" }));
  });

  it("drops cancelled and archived actions from the card altogether", () => {
    const state = seed();
    const room = state.actions.find((item) => item.id === "room-floor")!;
    render(
      <ProjectForecastGrid
        projects={state.projects}
        actions={[
          ...state.actions.filter((item) => item.id !== "room-floor"),
          { ...room, status: "archived" as const },
          { ...room, id: "room-cancelled", title: "Cancelled tidy", status: "cancelled" as const }
        ]}
        forecasts={[]}
        projectEnvelopes={[]}
        timezone="Australia/Sydney"
        onEditProject={() => {}}
      />
    );
    const roomCard = screen.getByText("Reset and clean my room").closest("article")!;
    expect(within(roomCard).queryByText(room.title)).toBeNull();
    expect(within(roomCard).queryByText("Cancelled tidy")).toBeNull();
  });

  it("matches each project to its own deliverables only", () => {
    const state = seed();
    render(
      <ProjectForecastGrid
        projects={state.projects}
        actions={state.actions}
        deliverables={[
          deliverable({ id: "assessment-2", projectId: "networking-assignment", title: "Assessment 2" }),
          deliverable({ id: "shell", projectId: "clean-room", title: "Room reset plan" })
        ]}
        forecasts={[]}
        projectEnvelopes={[]}
        timezone="Australia/Sydney"
        onEditProject={() => {}}
      />
    );
    const networkingCard = screen.getByText("Draft networking assignment section 1").closest("article")!;
    const roomCard = screen.getByText("Sort the bedroom floor").closest("article")!;
    expect(within(networkingCard).getByText("Assessment 2")).toBeTruthy();
    expect(within(networkingCard).queryByText("Room reset plan")).toBeNull();
    expect(within(roomCard).getByText("Room reset plan")).toBeTruthy();
    expect(within(roomCard).queryByText("Assessment 2")).toBeNull();
  });
});
