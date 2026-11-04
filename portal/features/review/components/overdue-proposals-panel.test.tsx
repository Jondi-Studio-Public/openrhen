// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { ClientForecast } from "@/state/portal-provider";
import { OverdueProposalsPanel } from "./overdue-proposals-panel";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const forecast = (extra: Partial<ClientForecast>): ClientForecast => ({
  projectId: state.projects[0]!.id,
  health: "behind",
  protectedRemainingMinutes: 120,
  pessimisticRemainingMinutes: 150,
  compatibleCapacityMinutes: 0,
  grossCompatibleCapacityMinutes: 0,
  reservedByEarlierDeadlinesMinutes: 0,
  requiredPaceMinutesPerWeek: null,
  forecastBand: "detailed",
  confidence: "high",
  forecastThrough: new Date("2026-08-25T00:00:00.000Z"),
  expectedMarginMinutes: -120,
  pessimisticMarginMinutes: -150,
  marginRatio: -1,
  scheduleVariance: null,
  unallocatedExpectedMinutes: 0,
  latestSafeStarts: {},
  reasons: [],
  ...extra
});

describe("OverdueProposalsPanel", () => {
  it("is a low-visibility disclosure that counts the overdue projects on its summary line", () => {
    const { container } = render(
      <OverdueProposalsPanel
        state={state}
        forecasts={[
          forecast({
            overdue: true,
            proposal: {
              kind: "move_deadline",
              deadlineOwner: "internal",
              missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
              earliestFeasibleAt: new Date("2026-08-20T04:00:00.000Z"),
              reason: "120 minutes of protected effort first fits unreserved capacity by then."
            }
          }),
          forecast({ projectId: state.projects[1]!.id, health: "on_track" })
        ]}
      />
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Proposals (1)");
  });

  it("proposes the earliest feasible date for an overdue self-set deadline, in the user's timezone", () => {
    render(
      <OverdueProposalsPanel
        state={state}
        forecasts={[
          forecast({
            overdue: true,
            proposal: {
              kind: "move_deadline",
              deadlineOwner: "internal",
              missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
              earliestFeasibleAt: new Date("2026-08-20T04:00:00.000Z"),
              reason: "120 minutes of protected effort first fits unreserved capacity by then."
            }
          }),
          forecast({ projectId: state.projects[1]!.id, health: "on_track" })
        ]}
      />
    );
    expect(screen.getByText(state.projects[0]!.title)).toBeTruthy();
    expect(
      screen.getByText(/Lapsed 17 Aug 2026, 6:00 pm \(self-set\)\. Move the internal date to 20 Aug 2026, 2:00 pm/)
    ).toBeTruthy();
    expect(screen.getByText(/first fits unreserved capacity/)).toBeTruthy();
    expect(screen.queryByText(state.projects[1]!.title)).toBeNull();
    expect(screen.getByText("Move the date in Plan").getAttribute("href")).toBe(
      `/plan/area-study#project-${state.projects[0]!.id}`
    );
  });

  it("says when nothing inside the horizon fits, and stays quiet (but present) when nothing is overdue", () => {
    const { unmount } = render(
      <OverdueProposalsPanel
        state={state}
        forecasts={[
          forecast({
            overdue: true,
            proposal: {
              kind: "move_deadline",
              deadlineOwner: "external",
              missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
              earliestFeasibleAt: null,
              reason: "The horizon runs out first."
            }
          })
        ]}
      />
    );
    expect(
      screen.getByText(/\(external\)\. The remaining effort does not fit anywhere in the next six months/)
    ).toBeTruthy();
    unmount();
    const second = render(<OverdueProposalsPanel state={state} forecasts={[forecast({})]} />);
    expect(screen.getByText("No project needs its date or plan changed.")).toBeTruthy();
    expect(second.container.querySelector("details")).toBeTruthy();
  });

  it("'Move all' sends the joint dates, while each card's Accept keeps its own date", () => {
    const [first, second] = state.projects;
    const onMoveAll = vi.fn();
    const onAccept = vi.fn();
    const proposal = (solo: string, joint: string) => ({
      kind: "move_deadline" as const,
      deadlineOwner: "internal" as const,
      missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
      earliestFeasibleAt: new Date(solo),
      jointEarliestFeasibleAt: new Date(joint),
      reason: "engine"
    });
    render(
      <OverdueProposalsPanel
        state={state}
        onMoveAll={onMoveAll}
        onAccept={onAccept}
        forecasts={[
          forecast({ overdue: true, proposal: proposal("2026-08-20T04:00:00.000Z", "2026-08-20T04:00:00.000Z") }),
          forecast({
            projectId: second!.id,
            overdue: true,
            proposal: proposal("2026-08-20T04:00:00.000Z", "2026-08-22T04:00:00.000Z")
          })
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Move all (2)" }));
    expect(onMoveAll).toHaveBeenCalledWith([
      { projectId: first!.id, date: new Date("2026-08-20T04:00:00.000Z") },
      { projectId: second!.id, date: new Date("2026-08-22T04:00:00.000Z") }
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Accept/ })[1]!);
    expect(onAccept).toHaveBeenCalledWith(second!.id, new Date("2026-08-20T04:00:00.000Z"));
  });

  it("lists a live project's interventions smallest first, naming the actions and formatting dates", () => {
    const [first, second] = state.projects;
    const action = state.actions.find((item) => item.projectId === first!.id)!;
    render(
      <OverdueProposalsPanel
        state={{ ...state, settings: { ...state.settings, timezone: "Australia/Sydney" } }}
        forecasts={[
          forecast({
            internalDeadlineAt: new Date("2026-08-20T07:00:00.000Z"),
            interventions: [
              { kind: "clarify_estimate", actionIds: [action.id], minutes: 45, reason: "engine" },
              { kind: "add_time", actionIds: [], minutes: 90, reason: "engine" },
              {
                kind: "move_deadline",
                actionIds: [],
                minutes: 90,
                proposedDeadlineAt: new Date("2026-08-21T04:00:00.000Z"),
                reason: "engine"
              }
            ]
          }),
          forecast({
            projectId: second!.id,
            interventions: [
              { kind: "request_extension", actionIds: [], minutes: 30, proposedDeadlineAt: null, reason: "engine" }
            ]
          })
        ]}
      />
    );
    expect(screen.getByText("Proposals (2)")).toBeTruthy();
    const items = [...document.querySelectorAll("li")].map((item) => item.textContent);
    expect(items[0]).toBe(
      `Narrow the estimate for ${action.title}. At its uncertain end it needs 45 more minutes than fit.`
    );
    expect(items[1]).toBe(
      "Add 90 minutes of suitable time before 20 Aug 2026, 5:00 pm, or pause other work to free them."
    );
    expect(items[2]).toContain("move the date to 21 Aug 2026, 2:00 pm");
    expect(items[3]).toContain("hand 30 minutes to someone else");
    expect(screen.getAllByText("Change it in Plan")).toHaveLength(2);
  });

  it("opens the editor for a project-level change, but links to Plan when an action's estimate or split is named", () => {
    const actionId = state.actions[0]!.id;
    const projectId = state.projects[0]!.id;
    const onEdit = vi.fn();
    const { rerender } = render(
      <OverdueProposalsPanel
        state={state}
        onEdit={onEdit}
        forecasts={[
          forecast({
            projectId,
            overdue: false,
            interventions: [{ kind: "add_time", minutes: 30, actionIds: [] }]
          } as unknown as Partial<ClientForecast>)
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change it" }));
    expect(onEdit).toHaveBeenCalledWith(projectId);
    rerender(
      <OverdueProposalsPanel
        state={state}
        onEdit={onEdit}
        forecasts={[
          forecast({
            projectId,
            overdue: false,
            interventions: [{ kind: "split_work", minutes: 30, actionIds: [actionId] }]
          } as unknown as Partial<ClientForecast>)
        ]}
      />
    );
    expect(screen.queryByRole("button", { name: "Change it" })).toBeNull();
    expect(screen.getByText("Change it in Plan")).toBeTruthy();
  });
});
