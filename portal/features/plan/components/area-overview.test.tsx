// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState, type StoredArea } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { AreaOverview } from "./area-overview";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const forecast = (overrides: Partial<ClientForecast>): ClientForecast => ({
  projectId: "networking-assignment",
  health: "on_track",
  protectedRemainingMinutes: 0,
  pessimisticRemainingMinutes: 0,
  compatibleCapacityMinutes: 0,
  grossCompatibleCapacityMinutes: 0,
  reservedByEarlierDeadlinesMinutes: 0,
  requiredPaceMinutesPerWeek: 0,
  forecastBand: null,
  confidence: null,
  forecastThrough: new Date("2026-09-01T00:00:00.000Z"),
  expectedMarginMinutes: null,
  pessimisticMarginMinutes: null,
  marginRatio: null,
  scheduleVariance: null,
  unallocatedExpectedMinutes: 0,
  latestSafeStarts: {},
  reasons: [],
  ...overrides
});

describe("AreaOverview", () => {
  const overview = (props: Partial<Parameters<typeof AreaOverview>[0]> = {}) => (
    <AreaOverview
      areas={[]}
      outcomes={[]}
      projects={[]}
      actions={[]}
      forecasts={[]}
      timezone="Australia/Sydney"
      {...props}
    />
  );
  const studyRow = () => screen.getByRole("link", { name: /Study/ });
  const twoStudyProjects = () => {
    const state = seed();
    return {
      state,
      projects: [state.projects[0]!, { ...state.projects[0]!, id: "second", outcomeId: state.projects[0]!.outcomeId }]
    };
  };

  it("sorts areas by sortOrder then name and links each to its own page", () => {
    const areas: StoredArea[] = [
      { id: "z", name: "Zulu", status: "active", sortOrder: 1 },
      { id: "a", name: "Alpha", status: "active", sortOrder: 1 },
      { id: "first", name: "First", status: "active", sortOrder: 0 }
    ];
    render(overview({ areas }));
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    expect(names.map((name) => name?.split("No description")[0])).toEqual(["First", "Alpha", "Zulu"]);
    expect(screen.getByRole("link", { name: /Alpha/ }).getAttribute("href")).toBe("/plan/a");
  });

  it("counts each area's outcomes and projects, and reads an overdue project as Overdue", () => {
    const state = seed();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects: state.projects,
        actions: state.actions,
        forecasts: [forecast({ projectId: "networking-assignment", health: "behind", overdue: true })]
      })
    );
    expect(studyRow().textContent).toContain("1 outcome");
    expect(studyRow().textContent).toContain("1 project");
    expect(studyRow().textContent).toContain("1 overdue");
    expect(studyRow().textContent).toContain("Overdue");
    expect(screen.getByRole("link", { name: /Home and administration/ }).textContent).not.toMatch(/overdue/i);
  });

  it("shows the worst health among an area's projects", () => {
    const { state, projects } = twoStudyProjects();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects,
        actions: state.actions,
        forecasts: [
          forecast({ projectId: "networking-assignment", health: "on_track" }),
          forecast({ projectId: "second", health: "behind" })
        ]
      })
    );
    expect(studyRow().textContent).toContain("Behind");
    expect(studyRow().textContent).not.toContain("On track");
  });

  it("ignores unknown members when rolling up health", () => {
    const { state, projects } = twoStudyProjects();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects,
        actions: state.actions,
        forecasts: [forecast({ projectId: "networking-assignment", health: "on_track" })]
      })
    );
    // "second" has no forecast at all, so it reads as unknown and must not sink the badge.
    expect(studyRow().textContent).toContain("On track");
  });

  it("rolls up a maintenance project by its adherence verdict rather than treating it as not forecast", () => {
    const { state, projects } = twoStudyProjects();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects,
        actions: state.actions,
        forecasts: [
          forecast({ projectId: "networking-assignment", health: "on_track" }),
          forecast({
            projectId: "second",
            health: "unknown",
            healthBasis: "adherence",
            adherence: { health: "behind" }
          } as never)
        ]
      })
    );
    expect(studyRow().textContent).toContain("Behind");
  });

  it("says No forecast when every member project is unforecastable", () => {
    const { state, projects } = twoStudyProjects();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects,
        actions: state.actions,
        forecasts: [
          forecast({ projectId: "networking-assignment", health: "unknown" }),
          forecast({ projectId: "second", health: "unknown" })
        ]
      })
    );
    expect(studyRow().textContent).toContain("No forecast");
  });

  it("still reads behind even when an unforecastable project sits alongside it", () => {
    const { state, projects } = twoStudyProjects();
    render(
      overview({
        areas: state.areas,
        outcomes: state.outcomes,
        projects,
        actions: state.actions,
        forecasts: [
          forecast({ projectId: "networking-assignment", health: "behind" }),
          forecast({ projectId: "second", health: "unknown" })
        ]
      })
    );
    expect(studyRow().textContent).toContain("Behind");
  });

  it("meters the share of an area's actions that are done, leaving cancelled ones out", () => {
    const state = seed();
    const base = state.actions.find((action) => action.projectId === "networking-assignment")!;
    const actions = [
      { ...base, id: "a1", status: "done" as const },
      { ...base, id: "a2", status: "active" as const },
      { ...base, id: "a3", status: "cancelled" as const }
    ];
    render(overview({ areas: state.areas, outcomes: state.outcomes, projects: state.projects, actions }));
    const meter = screen.getByRole("meter", { name: /Study: 1 of 2 actions done/ });
    expect(meter.getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("says no areas yet when there are none", () => {
    render(overview());
    expect(screen.getByText("No areas yet")).toBeTruthy();
  });

  it("gives a project with no resolvable area a row of its own, and hides it when there is none", () => {
    const state = seed();
    const orphan = { ...state.projects[0]!, id: "orphan", outcomeId: "gone", area: "Nowhere" };
    const { rerender } = render(overview({ areas: state.areas, outcomes: state.outcomes, projects: [orphan] }));
    expect(screen.getByRole("link", { name: /without an area/ }).getAttribute("href")).toBe("/plan/unassigned");
    rerender(overview({ areas: state.areas, outcomes: state.outcomes, projects: state.projects }));
    expect(screen.queryByText(/without an area/)).toBeNull();
  });

  it("still shows the unassigned door for an orphan action even when every project has an area", () => {
    const state = seed();
    const orphanAction = { ...state.actions[0]!, id: "orphan-action", projectId: "gone" };
    render(
      overview({ areas: state.areas, outcomes: state.outcomes, projects: state.projects, actions: [orphanAction] })
    );
    expect(screen.getByRole("link", { name: /without an area/ }).getAttribute("href")).toBe("/plan/unassigned");
  });

  it("still shows the unassigned door for an orphan outcome even when every project has an area", () => {
    const state = seed();
    const orphanOutcome = { ...state.outcomes[0]!, id: "orphan-outcome", areaId: "gone" };
    render(overview({ areas: state.areas, outcomes: [...state.outcomes, orphanOutcome], projects: state.projects }));
    expect(screen.getByRole("link", { name: /without an area/ }).getAttribute("href")).toBe("/plan/unassigned");
  });

  it("keeps archived areas behind a toggle at the end, out of the live list", () => {
    const areas: StoredArea[] = [
      { id: "live", name: "Live", status: "active", sortOrder: 0 },
      { id: "gone", name: "Gone", status: "archived", sortOrder: 1 },
      { id: "older", name: "Older", status: "archived", sortOrder: 2 }
    ];
    render(overview({ areas }));
    expect(screen.getByRole("link", { name: /Live/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Gone/ })).toBeNull();
    const toggle = screen.getByRole("button", { name: "2 archived areas" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("link", { name: /Gone/ }).textContent).toContain("Archived");
    expect(screen.getByRole("link", { name: /Older/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide archived areas" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("makes each row one link with no buttons inside it; editing happens on the area's page", () => {
    render(overview({ areas: [{ id: "a", name: "Alpha", status: "active", sortOrder: 0 }] }));
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  describe("the row's caption", () => {
    const withProject = (overrides: Record<string, unknown>) => {
      const state = seed();
      const projects = state.projects.map((project) =>
        project.id === "networking-assignment"
          ? { ...project, internalDeadlineAt: undefined, externalDeadlineAt: undefined, ...overrides }
          : project
      );
      return { state, projects };
    };

    it("names the next due date of an active project", () => {
      const { state, projects } = withProject({ externalDeadlineAt: "2099-03-14T01:00:00.000Z" });
      render(overview({ areas: state.areas, outcomes: state.outcomes, projects }));
      expect(studyRow().textContent).toMatch(/Next due Sat,? 14 Mar/);
    });

    it("counts lapsed self-set dates rather than calling them overdue", () => {
      const { state, projects } = withProject({});
      const lapsed = forecast({ overdue: true, proposal: { deadlineOwner: "internal" } } as never);
      render(overview({ areas: state.areas, outcomes: state.outcomes, projects, forecasts: [lapsed] }));
      expect(studyRow().textContent).toContain("1 date lapsed");
      expect(studyRow().textContent).not.toContain("Overdue");
    });

    it("asks for a date when an active project has none", () => {
      const { state, projects } = withProject({});
      render(overview({ areas: state.areas, outcomes: state.outcomes, projects }));
      expect(studyRow().textContent).toContain("Needs a date to forecast");
    });

    it("says nothing is active when every project is done or paused", () => {
      const { state, projects } = withProject({ status: "paused" });
      render(overview({ areas: state.areas, outcomes: state.outcomes, projects }));
      expect(studyRow().textContent).toContain("Nothing active");
      expect(studyRow().textContent).not.toContain("Needs a date");
    });
  });
});
