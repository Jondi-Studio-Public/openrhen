// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { AreaDetail } from "./area-detail";

const saveProjectCommand = vi.fn().mockResolvedValue(undefined);
const saveActionCommand = vi.fn().mockResolvedValue(undefined);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
const endRecurrenceGoalCommand = vi.fn().mockResolvedValue(undefined);
const recordCadenceCompletionCommand = vi.fn().mockResolvedValue(undefined);
let state: PortalState;
let ready = true;

// The work-label line fetches from the server; its own tests cover it.
vi.mock("@/features/plan/components/area-work-label", () => ({
  AreaWorkLabel: ({ areaId }: { areaId: string }) => <p>work label for {areaId}</p>
}));

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state,
    ready,
    forecasts: [],
    projectEnvelopes: [],
    saveProjectCommand,
    saveActionCommand,
    saveEntityCommand,
    endRecurrenceGoalCommand,
    recordCadenceCompletionCommand
  })
}));

beforeEach(() => {
  state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
  saveProjectCommand.mockClear();
  saveActionCommand.mockClear();
  saveEntityCommand.mockClear();
});

describe("AreaDetail", () => {
  it("shows a loading state rather than 'not here' while the portal is not ready", () => {
    ready = false;
    render(<AreaDetail areaId="area-study" />);
    expect(screen.getByText("Loading the area…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "That area is not here." })).toBeNull();
    ready = true;
  });

  it("treats a real area whose id collides with the reserved 'unassigned' id as the real area", () => {
    state = {
      ...state,
      areas: [...state.areas, { id: "unassigned", name: "Collision", status: "active", sortOrder: 5 }]
    };
    render(<AreaDetail areaId="unassigned" />);
    expect(screen.getByRole("heading", { level: 1, name: "Collision" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Unassigned" })).toBeNull();
  });

  it("shows the area's own name, outcomes, and only its own project", () => {
    render(<AreaDetail areaId="area-study" />);
    expect(screen.getByRole("heading", { level: 1, name: "Study" })).toBeTruthy();
    expect(screen.getByText("Complete Networking Assignment 2")).toBeTruthy();
    expect(screen.getByText("Submit Networking Assignment 2")).toBeTruthy();
    expect(screen.queryByText("Reset and clean my room")).toBeNull();
    expect(screen.queryByText("Make the bedroom calm and usable")).toBeNull();
  });

  it("puts the work-label line under a real area's heading, and not on the unassigned page", () => {
    render(<AreaDetail areaId="area-study" />);
    expect(screen.getByText("work label for area-study")).toBeTruthy();
    document.body.innerHTML = "";
    render(<AreaDetail areaId="unassigned" />);
    expect(screen.queryByText(/work label for/)).toBeNull();
  });

  it("keeps Plan's tabs under the area's heading, with Areas marked", () => {
    window.history.replaceState(null, "", "/plan/area-study");
    render(<AreaDetail areaId="area-study" />);
    const tabs = screen.getByRole("navigation", { name: "Plan" });
    expect(within(tabs).getByRole("link", { name: "Areas" }).getAttribute("aria-current")).toBe("page");
  });

  it("scrolls to and focuses the card the address names once the plan has loaded", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    window.history.replaceState(null, "", "/plan/area-study#project-networking-assignment");
    try {
      render(<AreaDetail areaId="area-study" />);
      const card = document.getElementById("project-networking-assignment")!;
      expect(scrolled).toEqual([card]);
      expect(document.activeElement).toBe(card);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("says an unknown area id is not here, with a way back", () => {
    render(<AreaDetail areaId="gone" />);
    expect(screen.getByRole("heading", { level: 1, name: "That area is not here." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Plan" }).getAttribute("href")).toBe("/plan");
  });

  it("renders the unassigned bucket without an outcomes section or an Edit area button", () => {
    const orphan = { ...state.projects[0]!, id: "orphan", outcomeId: "gone", area: "Nowhere" };
    state = { ...state, projects: [orphan] };
    render(<AreaDetail areaId="unassigned" />);
    expect(screen.getByRole("heading", { level: 1, name: "Unassigned" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Outcomes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit area" })).toBeNull();
    expect(screen.getByText(orphan.title)).toBeTruthy();
  });

  it("lists orphan actions and orphan outcomes on the unassigned bucket", () => {
    const orphanAction = { ...state.actions[0]!, id: "orphan-action", projectId: "gone" };
    const orphanOutcome = { ...state.outcomes[0]!, id: "orphan-outcome", areaId: "gone" };
    state = { ...state, actions: [...state.actions, orphanAction], outcomes: [...state.outcomes, orphanOutcome] };
    render(<AreaDetail areaId="unassigned" />);
    expect(screen.getByText(orphanAction.title)).toBeTruthy();
    expect(screen.getByText(orphanOutcome.title)).toBeTruthy();
  });

  it("opens the area sheet, pre-filled, from Edit area", () => {
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit area" }));
    const dialog = screen.getByRole("dialog", { name: "Edit area" });
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Study");
  });

  it("pre-fills New outcome with this area, and New project with its one outcome", () => {
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByRole("button", { name: "New outcome" }));
    expect(screen.getByRole("dialog", { name: "Add an outcome" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "Add a project" });
    expect((within(dialog).getByLabelText("Outcome") as HTMLSelectElement).value).toBe("outcome-networking");
  });

  it("leaves New project's outcome unset once the area has more than one outcome", () => {
    const secondOutcome = { ...state.outcomes[0]!, id: "outcome-second" };
    state = { ...state, outcomes: [...state.outcomes, secondOutcome] };
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "Add a project" });
    expect((within(dialog).getByLabelText("Outcome") as HTMLSelectElement).value).toBe("");
  });

  it("presets New action's project only when the area has exactly one project", () => {
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByRole("button", { name: "New action" }));
    const dialog = screen.getByRole("dialog", { name: "Add a concrete action" });
    expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe("networking-assignment");
  });

  it("presets New deliverable's project the same way as New action", () => {
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByRole("button", { name: "New deliverable" }));
    const dialog = screen.getByRole("dialog", { name: "Register or edit deliverables" });
    expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe("networking-assignment");
  });

  it("lists a project's deliverables under its own card, entering rather than expanding", () => {
    state = {
      ...state,
      deliverables: [
        {
          id: "assessment-2",
          version: 1,
          projectId: "networking-assignment",
          title: "Assessment 2",
          status: "needs_breakdown",
          uncertainty: "some",
          importance: 3,
          consequence: 3,
          contractVersion: 0,
          planVersion: 0,
          sortOrder: 0,
          dependencyIds: [],
          sourceIds: [],
          sourceFiles: [],
          steps: [],
          criteria: [],
          blockers: [],
          contractProposals: []
        }
      ]
    };
    render(<AreaDetail areaId="area-study" />);
    const link = screen.getByRole("link", { name: /Assessment 2/ });
    expect(link.getAttribute("href")).toBe("/deliverables?deliverable=assessment-2");
    // Neither approval is in yet, so this reads as Breakdown phase rather than its raw status.
    expect(screen.getByText("Breakdown")).toBeTruthy();
  });

  it("edits an action from its project's own row and closes the sheet once saved", async () => {
    render(<AreaDetail areaId="area-study" />);
    const disclosure = screen.getByText("Actions (1)").closest("details")!;
    fireEvent.click(screen.getByText("Actions (1)"));
    fireEvent.click(within(disclosure).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit action" });
    // The sheet now animates out rather than vanishing the moment `open` goes false, so this has to
    // wait for the save's own promise to settle (`act`, not a real-time `waitFor` poll) before the
    // "closing" phase shows up, then finish that transition itself rather than the real fallback timer.
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(dialog.getAttribute("data-phase")).toBe("closing");
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveActionCommand).toHaveBeenCalledTimes(1);
  });

  it("shows the page-level error banner only while no sheet is open", async () => {
    recordCadenceCompletionCommand.mockRejectedValueOnce(new Error("Could not record it."));
    const cadenceAction = {
      ...state.actions[0]!,
      id: "cadence-action",
      projectId: "networking-assignment",
      schedulingMode: "cadence" as const,
      recurrence: {
        id: "rule",
        actionId: "cadence-action",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        intervalDays: 1,
        completionMode: "manual" as const,
        accumulatedMinutes: 0,
        windows: []
      }
    };
    state = { ...state, actions: [...state.actions, cadenceAction] };
    render(<AreaDetail areaId="area-study" />);
    fireEvent.click(screen.getByText("Actions (2)"));
    fireEvent.click(screen.getByRole("button", { name: "Done today" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not record it.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
