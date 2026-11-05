// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import type { DeliverableDirective, DirectedDeliverable, NowCandidate } from "@/features/now/now-model";
import { freezeClock } from "@/shared/clock";
import { RecommendationPanel, recommendationKicker, travelKicker } from "./recommendation-panel";

const deliverableDirective: DeliverableDirective = {
  kind: "deliverable",
  targetId: "deliverable-1",
  title: "Assignment 2",
  recommendedMinutes: 45
};
const deliverable: DirectedDeliverable = {
  id: "deliverable-1",
  startStepId: "step-draft",
  version: 7,
  projectId: "networking-assignment",
  title: "Assignment 2",
  status: "ready",
  uncertainty: "some",
  importance: 5,
  consequence: 5,
  contractVersion: 1,
  planVersion: 1,
  sortOrder: 0,
  dependencyIds: [],
  sourceIds: [],
  sourceFiles: [],
  criteria: [],
  steps: [],
  blockers: [],
  contractProposals: []
};

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const candidate = (index: number, minutes: number | null): NowCandidate => ({
  action: state.actions[index]!,
  eligible: true,
  exclusionReasons: [],
  recommendedMinutes: minutes,
  totalScore: 12,
  scoreComponents: { deadlinePressure: 5 }
});

const props = {
  primary: candidate(0, 45),
  timezone: "Australia/Sydney",
  saving: false,
  planningDecisionCurrent: true,
  explanation: "This is the most pressing work that fits.",
  evidence: ["Deadline in seven days"],
  plannedEnd: new Date(now.getTime() + 45 * 60_000),
  nextCommitment: state.commitments[0]!,
  forecast: undefined,
  alternatives: [] as NowCandidate[],
  deliverableDirective: null,
  directedDeliverable: undefined,
  overrideReason: "better_fit" as const,
  onOverrideReasonChange: vi.fn(),
  onStartCurrent: vi.fn(),
  startAlternative: vi.fn().mockResolvedValue(undefined),
  blockRecommended: vi.fn().mockResolvedValue(undefined),
  runActivityCommand: vi.fn().mockResolvedValue(undefined)
};

describe("RecommendationPanel", () => {
  // Dates in these tests are fixed literals; the shared clock must not drift past them (a date bomb from 2026-11-13).
  beforeEach(() => {
    freezeClock(now);
  });

  it("opens with one plain sentence and keeps the engine's wording and numbers under the workings", () => {
    const engineText =
      "Project due internally Wed, Nov 4, 7:00 PM; 45 minutes fit. It leads Ask Dana 72.5 to 66.5 on the weighted ranking.";
    render(
      <RecommendationPanel
        {...props}
        explanation={engineText}
        primary={{
          ...candidate(0, 45),
          action: { ...state.actions[0]!, deadlineAt: "2026-11-13T05:00:00.000Z" },
          criticalTier: "at_risk_external",
          criticalReason: "Only 12% margin remains against external deadline."
        }}
      />
    );
    const why = screen.getByText("Why this, now").parentElement!;
    const details = why.querySelector("details")!;
    const open = Array.from(why.children).filter((node) => node !== details);
    const visible = open.map((node) => node.textContent).join(" ");
    expect(visible).toMatch(/Due Fri,? (13 Nov|Nov 13), and a 45 min session fits now\./);
    expect(visible).not.toMatch(/weighted|72\.5|margin remains/);
    expect(details.textContent).toContain("It leads Ask Dana 72.5 to 66.5 on the weighted ranking.");
  });

  it("says a passed date as past and an undated task without a date", () => {
    const { unmount } = render(
      <RecommendationPanel
        {...props}
        primary={{ ...candidate(0, 30), action: { ...state.actions[0]!, deadlineAt: "2026-08-10T05:00:00.000Z" } }}
      />
    );
    expect(screen.getByText(/^Was due Mon,? (10 Aug|Aug 10), and a 30 min session fits now\.$/)).toBeTruthy();
    unmount();
    render(
      <RecommendationPanel
        {...props}
        primary={{ ...candidate(0, 30), action: { ...state.actions[0]!, deadlineAt: undefined } }}
      />
    );
    expect(screen.getByText("Nothing is due soon; a 30 min session fits now.")).toBeTruthy();
  });

  it("shows no Start or Not now for an action already finished, only a placeholder", () => {
    render(<RecommendationPanel {...props} finished />);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Finding the next thing/);
  });

  it("says Due around when only the forecast date is known", () => {
    render(
      <RecommendationPanel
        {...props}
        primary={{ ...candidate(0, 30), action: { ...state.actions[0]!, deadlineAt: undefined } }}
        forecast={
          { health: "on_track", internalDeadlineAt: new Date("2026-11-13T05:00:00.000Z") } as unknown as NonNullable<
            typeof props.forecast
          >
        }
      />
    );
    expect(screen.getByText(/^Due around Fri,? (13 Nov|Nov 13), and a 30 min session fits now\.$/)).toBeTruthy();
  });

  it("starts the recommended action and names the next commitment", () => {
    const onStartCurrent = vi.fn();
    render(<RecommendationPanel {...props} onStartCurrent={onStartCurrent} />);
    expect(screen.getByText(/^It fits before Dinner and reset at /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStartCurrent).toHaveBeenCalledTimes(1);
  });

  it("keeps Start and Not now pressable while another command is saving", () => {
    const onStartCurrent = vi.fn().mockResolvedValue(undefined);
    render(<RecommendationPanel {...props} saving onStartCurrent={onStartCurrent} />);
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    expect(onStartCurrent).toHaveBeenCalledTimes(1);
  });

  it("disables only Start while its own command is in flight, and sends a double tap once", async () => {
    let finish!: () => void;
    const onStartCurrent = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<RecommendationPanel {...props} onStartCurrent={onStartCurrent} />);
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    fireEvent.click(start);
    fireEvent.click(start);
    expect(onStartCurrent).toHaveBeenCalledTimes(1);
    expect(start.disabled).toBe(true);
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(false);
    finish();
    await waitFor(() => expect(start.disabled).toBe(false));
  });

  it("disables every Start while the plan is not current, leaving Not now available", () => {
    const onStartCurrent = vi.fn();
    const startAlternative = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <RecommendationPanel
        {...props}
        planningDecisionCurrent={false}
        alternatives={[candidate(1, 30)]}
        onStartCurrent={onStartCurrent}
        startAlternative={startAlternative}
      />
    );
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(onStartCurrent).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/until the plan refreshes/);
    // An alternative in the Something else sheet cannot start either.
    fireEvent.click(screen.getByRole("button", { name: "Something else…" }));
    const row = screen.getByRole("button", { name: /Sort the bedroom floor/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(startAlternative).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toMatch(/until the plan refreshes/);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    render(
      <RecommendationPanel
        {...props}
        planningDecisionCurrent={false}
        deliverableDirective={deliverableDirective}
        directedDeliverable={deliverable}
      />
    );
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says whether the plan is on its way, retrying or stuck beside the disabled Start", () => {
    const { rerender } = render(
      <RecommendationPanel {...props} planningDecisionCurrent={false} planRefresh="refreshing" />
    );
    expect(screen.getByRole("status").textContent).toMatch(/Updating the plan/);
    rerender(<RecommendationPanel {...props} planningDecisionCurrent={false} planRefresh="retrying" />);
    expect(screen.getByRole("status").textContent).toMatch(/will retry/);
    rerender(<RecommendationPanel {...props} planningDecisionCurrent={false} planRefresh="stalled" />);
    expect(screen.getByRole("status").textContent).toMatch(/not refreshing/);
  });

  it("puts Refresh the plan beside the disabled Start only when the plan lapsed with none on its way", () => {
    const onRefreshPlan = vi.fn();
    const refresh = (planRefresh?: "stalled" | "current" | "retrying" | "refreshing") => (
      <RecommendationPanel
        {...props}
        planningDecisionCurrent={false}
        planRefresh={planRefresh}
        onRefreshPlan={onRefreshPlan}
      />
    );
    const { rerender } = render(refresh("current"));
    // The status poll calls a lapsed plan current while no refresh is on its way.
    fireEvent.click(screen.getByRole("button", { name: "Refresh the plan" }));
    expect(onRefreshPlan).toHaveBeenCalledTimes(1);
    // A stalled refresh already has the banner's button; retrying lands on its own, refreshing is under
    // way, and an unknown status says nothing yet.
    for (const quiet of ["stalled", "retrying", "refreshing", undefined] as const) {
      rerender(refresh(quiet));
      expect(screen.queryByRole("button", { name: "Refresh the plan" })).toBeNull();
    }
    rerender(<RecommendationPanel {...props} planningDecisionCurrent onRefreshPlan={onRefreshPlan} />);
    expect(screen.queryByRole("button", { name: "Refresh the plan" })).toBeNull();
  });

  it("states the clock minutes only when they differ from the focused minutes", () => {
    const { unmount } = render(
      <RecommendationPanel {...props} primary={{ ...candidate(0, 45), recommendedWallClockMinutes: 60 }} />
    );
    expect(screen.getByText("For 45 focused minutes (60 by the clock), then check in.")).toBeTruthy();
    unmount();
    render(<RecommendationPanel {...props} primary={{ ...candidate(0, 45), recommendedWallClockMinutes: 45 }} />);
    expect(screen.getByText("For 45 focused minutes, then check in.")).toBeTruthy();
  });

  it("labels the deadline tier and explains why not the runner-up, but stays quiet for ordinary work", () => {
    const { unmount } = render(
      <RecommendationPanel
        {...props}
        primary={{ ...candidate(0, 45), criticalTier: "behind_external", criticalReason: "Behind by 90 minutes." }}
        why={{
          because: null,
          whyNot: {
            targetId: "other",
            title: "Write the report",
            tier: "ordinary",
            tierLabel: "Ordinary weighted ranking",
            reason: "It leads because behind an external deadline outranks ordinary weighted ranking.",
            decidingFactor: "tier"
          },
          wouldChangeIf: [
            {
              condition: "energy_high",
              description: "if your energy were high",
              thenPrimary: { targetId: "deep", title: "Deep analysis", recommendedMinutes: 60 }
            }
          ]
        }}
      />
    );
    expect(screen.getByText("Behind · external deadline")).toBeTruthy();
    expect(screen.getByText("Why not Write the report?")).toBeTruthy();
    expect(screen.getByText(/decided by tier/)).toBeTruthy();
    expect(screen.getByText(/if your energy were high: Deep analysis for 60 minutes/)).toBeTruthy();
    unmount();
    render(<RecommendationPanel {...props} primary={{ ...candidate(0, 45), criticalTier: "ordinary" }} />);
    expect(screen.queryByText("Ordinary ranking")).toBeNull();
    expect(screen.queryByText(/Why not/)).toBeNull();
  });

  it("says the area has no forecast rather than inventing a margin", () => {
    render(<RecommendationPanel {...props} />);
    expect(screen.getByText("This area has no forecast yet.")).toBeTruthy();
    expect(screen.queryByText(/slack in the plan|short in the plan/)).toBeNull();
  });

  it("shows overdue outright for a past-deadline project the engine could not otherwise forecast", () => {
    const { unmount } = render(
      <RecommendationPanel {...props} forecast={{ health: "unknown", overdue: true } as never} />
    );
    expect(screen.getByText("This area is overdue.")).toBeTruthy();
    expect(screen.queryByText(/unknown/)).toBeNull();
    unmount();
    render(<RecommendationPanel {...props} forecast={{ health: "behind", overdue: true } as never} />);
    expect(screen.getByText("This area is behind · overdue.")).toBeTruthy();
  });

  it("blocks the recommendation with the reason tapped in the Why not now sheet", () => {
    const blockRecommended = vi.fn().mockResolvedValue(undefined);
    render(<RecommendationPanel {...props} blockRecommended={blockRecommended} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("heading", { name: "Why not now?" })).toBeTruthy();
    expect(blockRecommended).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Something else has to happen first" }));
    expect(blockRecommended).toHaveBeenCalledWith("dependency");
  });

  describe("snoozing from the Not now sheet", () => {
    // 20:00 in the seed zone: too late in the evening for Later today, so the chips start at Tomorrow.
    const morning = new Date("2026-08-17T23:30:00.000Z"); // 9:30 am Tuesday 18 Aug in the seed zone
    const open = (
      extra: Partial<typeof props> & {
        snoozeRecommended?: Mock<(availableFrom: string) => Promise<void>>;
        projects?: { id: string; externalDeadlineAt?: string }[];
      } = {},
      at = now
    ) => {
      freezeClock(at);
      const snoozeRecommended =
        extra.snoozeRecommended ?? vi.fn<(availableFrom: string) => Promise<void>>().mockResolvedValue(undefined);
      const view = render(<RecommendationPanel {...props} {...extra} snoozeRecommended={snoozeRecommended} />);
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      return { snoozeRecommended, ...view };
    };

    it("offers when it can come back first, and the blocking reasons under their own heading", () => {
      open({}, morning);
      for (const label of ["Later today", "Tomorrow", "Next week", "Pick a date"]) {
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
      }
      expect(screen.getByRole("heading", { name: "Blocked by something" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Missing information" })).toBeTruthy();
    });

    it("leaves Later today out in the evening", () => {
      open();
      expect(screen.queryByRole("button", { name: "Later today" })).toBeNull();
      expect(screen.getByRole("button", { name: "Tomorrow" })).toBeTruthy();
    });

    it("sends the start of tomorrow in the plan zone, and no block", () => {
      const { snoozeRecommended } = open();
      fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
      // 20:00 Tuesday 18 Aug in the seed zone; tomorrow starts at 2026-08-19T00:00 +10:00.
      expect(snoozeRecommended).toHaveBeenCalledWith("2026-08-18T14:00:00.000Z");
      expect(props.blockRecommended).not.toHaveBeenCalled();
    });

    it("sends the picked day's start for Pick a date", () => {
      const { snoozeRecommended } = open();
      fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
      fireEvent.change(screen.getByLabelText("Come back on"), { target: { value: "2026-08-21" } });
      fireEvent.click(screen.getByRole("button", { name: "Set date" }));
      expect(snoozeRecommended).toHaveBeenCalledWith("2026-08-20T14:00:00.000Z");
    });

    it("refuses a day past the latest safe start and says why, without saving", () => {
      const action = { ...state.actions[0]!, latestStartAt: "2026-08-20T00:00:00.000Z" };
      const { snoozeRecommended } = open({ primary: { ...props.primary, action } });
      fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
      fireEvent.change(screen.getByLabelText("Come back on"), { target: { value: "2026-08-25" } });
      fireEvent.click(screen.getByRole("button", { name: "Set date" }));
      expect(screen.getByRole("alert").textContent).toMatch(/latest safe start/i);
      expect(snoozeRecommended).not.toHaveBeenCalled();
    });

    it("disables a chip that would land past the deadline", () => {
      const action = { ...state.actions[0]!, deadlineAt: "2026-08-18T13:00:00.000Z" };
      open({
        primary: { ...props.primary, action },
        projects: [{ id: action.projectId, externalDeadlineAt: "2026-08-18T13:00:00.000Z" }]
      });
      expect((screen.getByRole("button", { name: /^Tomorrow/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("allows a snooze when only the action's own target is past, but the external deadline is ahead", () => {
      const action = { ...state.actions[0]!, deadlineAt: "2026-08-10T13:00:00.000Z" };
      const { snoozeRecommended } = open({
        primary: { ...props.primary, action },
        projects: [{ id: action.projectId, externalDeadlineAt: "2026-08-30T13:00:00.000Z" }]
      });
      fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
      expect(snoozeRecommended).toHaveBeenCalledWith("2026-08-18T14:00:00.000Z");
    });

    it("does not offer a chip that would pull an existing later availableFrom earlier", () => {
      const action = { ...state.actions[0]!, availableFrom: "2026-08-25T00:00:00.000Z" };
      open({ primary: { ...props.primary, action } });
      expect((screen.getByRole("button", { name: "Tomorrow" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers no snooze for a recurring series, only the blocking reasons", () => {
      const action = { ...state.actions[0]!, schedulingMode: "recurring" as const };
      open({ primary: { ...props.primary, action } });
      expect(screen.queryByRole("button", { name: "Tomorrow" })).toBeNull();
      expect(screen.getByRole("button", { name: "Missing information" })).toBeTruthy();
    });
  });

  it("switches to an alternative with the reason for the switch chosen in the sheet", () => {
    const startAlternative = vi.fn().mockResolvedValue(undefined);
    render(
      <RecommendationPanel
        {...props}
        alternatives={[candidate(1, 20)]}
        overrideReason="lower_energy"
        startAlternative={startAlternative}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Something else…" }));
    expect(screen.getByRole("heading", { name: "Something else" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lower energy" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Better fit now" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Sort the bedroom floor/ }));
    expect(startAlternative).toHaveBeenCalledWith("room-floor", 20, "lower_energy");
  });

  it("says so plainly when nothing else fits the window", () => {
    render(<RecommendationPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Something else…" }));
    expect(screen.getByText("Nothing else on the list fits right now.")).toBeTruthy();
    expect(screen.queryByText("Why switch?")).toBeNull();
    expect(screen.getByRole("button", { name: /Something came up/ })).toBeTruthy();
  });

  it("starts a directed deliverable rather than the plain action", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    const onStartCurrent = vi.fn();
    render(
      <RecommendationPanel
        {...props}
        onStartCurrent={onStartCurrent}
        deliverableDirective={deliverableDirective}
        directedDeliverable={deliverable}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStartCurrent).not.toHaveBeenCalled();
    expect(runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start_activity",
        targetType: "deliverable",
        targetId: "deliverable-1",
        plannedMinutes: 45,
        expectedVersion: 7,
        stepId: "step-draft"
      })
    );
  });

  it("starts with no step when the plan has none executable, rather than inventing one", () => {
    const runActivityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <RecommendationPanel
        {...props}
        deliverableDirective={deliverableDirective}
        directedDeliverable={{ ...deliverable, startStepId: null }}
        runActivityCommand={runActivityCommand}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(runActivityCommand.mock.calls[0]![0]).not.toHaveProperty("stepId");
  });

  it("refuses to start a directed deliverable the portal does not hold", () => {
    render(<RecommendationPanel {...props} deliverableDirective={deliverableDirective} />);
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("recommendationKicker", () => {
  it("says do it now when nothing holds the start back", () => {
    const text = recommendationKicker(candidate(0, 45), new Date("2026-08-18T11:00:00.000Z"), "Australia/Sydney");
    expect(text).toMatch(/^Do this now · about 45 min, until /);
  });

  it("says after a break until when deadline work is still resting", () => {
    const text = recommendationKicker(
      candidate(0, 45),
      new Date("2026-08-18T11:00:00.000Z"),
      "Australia/Sydney",
      new Date("2026-08-18T10:15:00.000Z")
    );
    expect(text).toMatch(/^After a break until 8:15 pm · about 45 min, until /);
    expect(text).not.toContain("Do this now");
  });
});

describe("travelKicker", () => {
  it("says time to go when nothing holds the journey back", () => {
    expect(travelKicker("Australia/Sydney")).toBe("Time to go");
  });

  it("puts the break first when the work the journey leads to is still resting", () => {
    expect(travelKicker("Australia/Sydney", new Date("2026-08-18T10:15:00.000Z"))).toBe(
      "Take a break until 8:15 pm, then leave"
    );
  });
});
