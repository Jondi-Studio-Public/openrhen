// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { childrenOpenRefusal, closeEntityCommandSchema } from "@openrhen/contracts";
import { resultFor } from "@/test/close-fixtures";
import { CommandRefusal } from "@/shared/command-refusal";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { periodFor } from "@/features/review/planning-focus-period";

const now = new Date("2026-08-30T00:00:00.000Z");
const seed = createSeedState(now);
// The page reads the shared clock rather than a plain `new Date()`, so tests freeze it to the same
// instant the fixtures are built against.
freezeClock(now);

function buildState(overrides: Partial<typeof seed> = {}) {
  return { ...seed, ...overrides };
}

// Stands in for the server's close route: a body it would refuse fails the test, and the result is the real helper's.
const closeEntityCommand = vi.fn(async (command: unknown) => {
  const parsed = closeEntityCommandSchema.parse(command);
  return resultFor(parsed, { version: 3, ...(parsed.do === "restore" ? { closedFrom: "active" } : {}) });
});

const baseContext = {
  closeEntityCommand,
  ready: true,
  capacityEnvelopes: [{ adjustedCapacityMinutes: 600 }],
  forecasts: [],
  weekOutlook: null,
  saveActionCommand: vi.fn(),
  saveEntityCommand: vi.fn(),
  saveProjectCommand: vi.fn((_command: unknown) => Promise.resolve()),
  confirmProjectWantedCommand: vi.fn((_command: { projectId: string; expectedVersion: number }) => Promise.resolve())
};

/** A Keep as the server applies it: the project's `lastReviewedAt` becomes now, and the next render reads it. */
function keepsOnTheServer() {
  return vi.fn((command: { projectId: string; expectedVersion: number }) => {
    context = {
      ...context,
      state: {
        ...context.state,
        projects: context.state.projects.map((project) =>
          project.id === command.projectId ? { ...project, lastReviewedAt: now.toISOString() } : project
        )
      }
    };
    return Promise.resolve();
  });
}

let context: typeof baseContext & { state: ReturnType<typeof buildState> };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

// The correction card loads its own list; here there is nothing to show, so only its own test sees its alert.
const reasonTags = vi.hoisted(() => ({ fetchReasonTags: vi.fn() }));
vi.mock("@/features/check-in/reason-tag-client", async (original) => ({
  ...(await original<typeof import("@/features/check-in/reason-tag-client")>()),
  fetchReasonTags: reasonTags.fetchReasonTags
}));

// Imported after the mock is declared (vi.mock calls are hoisted above imports by vitest, so this
// import already resolves against the mocked provider).
import ReviewPage from "./page";
import { refreshAgentProposals, resetAgentProposals } from "@/features/agent-proposals/agent-proposals-store";

describe("Review page composition", () => {
  // An earlier test moves the shared clock forward; every test here reads the same instant its fixtures use.
  beforeEach(() => {
    freezeClock(now);
    reasonTags.fetchReasonTags.mockReset();
    reasonTags.fetchReasonTags.mockResolvedValue({ modelConfigured: false, reasons: [] });
  });

  it("shows the correction card's own alert, and only it, when the list of reasons cannot be loaded", async () => {
    reasonTags.fetchReasonTags.mockRejectedValue(new Error("Could not reach the portal. Try again."));
    context = { ...baseContext, state: buildState() };
    render(<ReviewPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Your reasons could not be loaded");
  });

  it("ticks off the steps that have nothing left, and shows a zero focus line", () => {
    // Both seed projects otherwise read as "stale" (no lastWorkedAt) — give them recent work so the
    // default fixture reads as clean, matching what a freshly-reviewed plan looks like.
    const state = buildState({
      projects: seed.projects.map((project) => ({ ...project, lastWorkedAt: now.toISOString() })),
      actions: seed.actions.map((action) => ({ ...action, status: "active" as const }))
    });
    context = { ...baseContext, state };
    render(<ReviewPage />);
    expect(screen.getByRole("heading", { name: /^Clear blockers/ }).textContent).toContain("(done)");
    expect(screen.getByText("Nothing is blocked.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Wake up stale projects/ }).textContent).toContain("(done)");
    expect(screen.queryByText("Outcome reviews and deadlines")).toBeNull();
    expect(screen.queryByText("Recurring series ready")).toBeNull();
    expect(screen.getByText(/0 selected this week · 0 selected this month/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Choose focus" }).getAttribute("href")).toBe("/review/focus");
  });

  it("dropped Plan's duplicated sections: blocked/waiting, uncertain estimates, and missing-next-action lists", () => {
    const state = buildState({
      projects: seed.projects.map((project) => ({ ...project, lastWorkedAt: now.toISOString() }))
    });
    context = { ...baseContext, state };
    render(<ReviewPage />);
    expect(screen.queryByText("Blocked or waiting")).toBeNull();
    expect(screen.queryByText("Estimates needing review")).toBeNull();
    expect(screen.queryByText("Projects missing a next action")).toBeNull();
    expect(screen.queryByText(/reserved of.*usable.*free/)).toBeNull();
  });

  it("shows the strip with the exact counts and keeps the recurring-series controls working underneath", () => {
    const dueOutcome = { ...seed.outcomes[1]!, reviewOn: "2026-08-01" };
    const endedAction = {
      ...seed.actions[0]!,
      id: "reading-practice",
      title: "Read for 20 minutes",
      status: "active" as const,
      schedulingMode: "recurring" as const,
      recurrence: {
        id: "reading-practice-rule",
        actionId: "reading-practice",
        timezone: seed.settings.timezone,
        startDate: "2026-08-01",
        endDate: "2026-08-20",
        intervalDays: 1,
        windows: [
          {
            id: "evening",
            name: "Evening",
            anchor: "local_time" as const,
            localStartTime: "19:00",
            localEndTime: "20:00"
          }
        ],
        completionMode: "end_date" as const,
        accumulatedMinutes: 0
      }
    };
    const state = buildState({
      // networking-assignment gets recent work; clean-room is left stale (no lastWorkedAt).
      projects: [{ ...seed.projects[0]!, lastWorkedAt: now.toISOString() }, seed.projects[1]!],
      outcomes: [seed.outcomes[0]!, dueOutcome],
      actions: [...seed.actions, endedAction]
    });
    context = { ...baseContext, state };
    render(<ReviewPage />);

    // clean-room is stale, so step 2 lists it with Keep, Pause and Drop.
    const stale = screen.getByRole("region", { name: "Step 2: Wake up stale projects" });
    expect(stale.textContent).toContain(seed.projects[1]!.title);
    expect(stale.textContent).toContain("1 left");
    // The due outcome goes to its own card, not the top of Plan.
    const outcomes = screen.getByRole("region", { name: /Outcome reviews and deadlines/ });
    expect(outcomes.textContent).toContain("1");
    expect(screen.getByText("Review due 2026-08-01")).toBeTruthy();
    // Acted on in place: Keep going and Close are buttons, not a link out to Plan.
    expect(within(outcomes).getByRole("button", { name: "Keep going" })).toBeTruthy();
    expect(within(outcomes).getByRole("button", { name: "Close outcome" })).toBeTruthy();
    expect(within(outcomes).getByRole("link", { name: dueOutcome.title }).getAttribute("href")).toBe(
      "/plan/area-home#outcome-outcome-room"
    );

    const series = screen.getByRole("region", { name: /Recurring series ready/ });
    expect(series.textContent).toContain(endedAction.title);

    context.saveActionCommand.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    expect(context.saveActionCommand).toHaveBeenCalledTimes(1);
    const command = context.saveActionCommand.mock.calls[0]![0];
    expect(command.action).toMatchObject({ id: "reading-practice", status: "done" });
  });

  // Finding 31(c): the page used to read a plain `new Date()`, computed once whenever it happened to
  // render and never again on its own — a tab left open showed stale counts as items came due behind
  // it. It now subscribes to the shared clock like Today and Now, so time passing alone recomputes it.
  it("catches an outcome coming due as the clock ticks forward, with no state change at all", () => {
    const dueSoon = { ...seed.outcomes[1]!, reviewOn: "2026-08-31" };
    const state = buildState({
      projects: seed.projects.map((project) => ({ ...project, lastWorkedAt: now.toISOString() })),
      outcomes: [seed.outcomes[0]!, dueSoon]
    });
    context = { ...baseContext, state };
    render(<ReviewPage />);
    // Not due yet as of `now` (2026-08-30): nothing to list.
    expect(screen.queryByText("Outcome reviews and deadlines")).toBeNull();

    act(() => {
      freezeClock(new Date("2026-09-01T00:00:00.000Z"));
    });

    expect(screen.getByText("Outcome reviews and deadlines")).toBeTruthy();
    expect(screen.getByText("Review due 2026-08-31")).toBeTruthy();
  });

  it("pauses a stale project as a status change, and drops it through the close route", async () => {
    const state = buildState({
      projects: [{ ...seed.projects[0]!, lastWorkedAt: now.toISOString() }, seed.projects[1]!]
    });
    context = { ...baseContext, state, saveProjectCommand: vi.fn(() => Promise.resolve()) };
    render(<ReviewPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    const command = (
      context.saveProjectCommand.mock.calls as unknown as [{ project: { id: string; status: string } }][]
    )[0]![0];
    expect(command.project).toMatchObject({ id: seed.projects[1]!.id, status: "paused" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    });
    // a drop is a cancel: it goes through the close route (stamped as the person, cascading like an agent's), not a status save
    expect(context.saveProjectCommand).toHaveBeenCalledTimes(1);
    expect(closeEntityCommandSchema.parse(closeEntityCommand.mock.calls.at(-1)![0])).toMatchObject({
      type: "project",
      id: seed.projects[1]!.id,
      verb: "cancel",
      do: "close"
    });
    expect(context.confirmProjectWantedCommand).not.toHaveBeenCalled();
  });

  it("keeps a stale project by sending the confirm command, which the server stores", async () => {
    const state = buildState({
      projects: [
        { ...seed.projects[0]!, lastWorkedAt: now.toISOString() },
        { ...seed.projects[1]!, version: 3 }
      ]
    });
    context = { ...baseContext, state, confirmProjectWantedCommand: keepsOnTheServer() };
    render(<ReviewPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    });
    expect(context.confirmProjectWantedCommand).toHaveBeenCalledTimes(1);
    expect(context.confirmProjectWantedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: seed.projects[1]!.id,
        expectedVersion: 3
      })
    );
    expect(context.saveProjectCommand).not.toHaveBeenCalled();
    // The kept project reads its new lastReviewedAt, so it is no longer stale.
    expect(screen.getByRole("heading", { name: /^Wake up stale projects/ }).textContent).toContain("(done)");
  });

  it("says so when a keep fails, and leaves the project in the list", async () => {
    context = {
      ...baseContext,
      state: buildState({ projects: [{ ...seed.projects[1]!, version: 3 }] }),
      confirmProjectWantedCommand: vi.fn(() => Promise.reject(new Error("This project was changed elsewhere.")))
    };
    render(<ReviewPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("This project was changed elsewhere.");
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
  });

  describe("step 2 on a busy week", () => {
    const staleProjects = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...seed.projects[1]!,
        version: 2,
        id: `stale-${index}`,
        title: `Stale project ${index + 1}`
      }));

    it("lists every stale project on a desk, with a Keep all remaining button", async () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
      context = { ...baseContext, state: buildState({ projects: staleProjects(5) }) };
      render(<ReviewPage />);
      const step = screen.getByRole("region", { name: "Step 2: Wake up stale projects" });
      expect(step.textContent).toContain("5 left");
      expect(screen.getAllByRole("button", { name: "Keep" })).toHaveLength(5);
      expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
      vi.unstubAllGlobals();
    });

    it("keeps every remaining project in one tap, and Undo puts the earlier stamps back", async () => {
      const confirm = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: buildState({
          projects: [...staleProjects(2), { ...staleProjects(3)[2]!, lastReviewedAt: "2026-07-01T00:00:00.000Z" }]
        }),
        confirmProjectWantedCommand: confirm
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep all remaining (3)" }));
      });
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("status").textContent).toContain("Kept 3 projects for 30 days.");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      const calls = confirm.mock.calls.map(([command]) => command as { projectId: string; reviewedAt: string | null });
      expect(calls.slice(3).map((command) => [command.projectId, command.reviewedAt])).toEqual([
        ["stale-0", null],
        ["stale-1", null],
        ["stale-2", "2026-07-01T00:00:00.000Z"]
      ]);
    });

    it("puts a single Keep in the Undo toast and undoes it", async () => {
      const confirm = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: buildState({ projects: staleProjects(1) }),
        confirmProjectWantedCommand: confirm
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep" }));
      });
      expect(screen.getByRole("status").textContent).toContain("Kept Stale project 1 for 30 days.");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(confirm.mock.calls[1]![0]).toMatchObject({ projectId: "stale-0", expectedVersion: 2, reviewedAt: null });
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("does not offer Keep all remaining for a single project", () => {
      context = { ...baseContext, state: buildState({ projects: staleProjects(1) }) };
      render(<ReviewPage />);
      expect(screen.queryByRole("button", { name: /Keep all remaining/ })).toBeNull();
    });

    it("holds a project kept 10 days ago off the list, and never lists a focus project", () => {
      const [kept, focus, stale] = staleProjects(3);
      context = {
        ...baseContext,
        state: buildState({
          projects: [
            { ...kept!, lastReviewedAt: "2026-08-20T00:00:00.000Z" },
            { ...focus!, internalDeadlineAt: undefined, externalDeadlineAt: undefined },
            stale!
          ],
          planningFocus: [
            {
              id: "focus-1",
              version: 1,
              kind: "weekly",
              periodStart: periodFor("weekly", now, seed.settings.timezone).start,
              periodEnd: periodFor("weekly", now, seed.settings.timezone).end,
              projectIds: [focus!.id]
            }
          ] as unknown as typeof seed.planningFocus
        })
      };
      render(<ReviewPage />);
      const step = screen.getByRole("region", { name: "Step 2: Wake up stale projects" });
      expect(step.textContent).toContain("Stale project 3");
      expect(step.textContent).not.toContain("Stale project 1");
      expect(step.textContent).not.toContain("Stale project 2");
    });

    it("shows one at a time on a phone, counted as 1 of N", async () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(max-width: 719px)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
      context = {
        ...baseContext,
        state: buildState({ projects: staleProjects(4) }),
        confirmProjectWantedCommand: keepsOnTheServer()
      };
      render(<ReviewPage />);
      const step = screen.getByRole("region", { name: "Step 2: Wake up stale projects" });
      expect(step.textContent).toContain("1 of 4");
      expect(screen.getAllByRole("button", { name: "Keep" })).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep" }));
      });
      expect(step.textContent).toContain("2 of 4");
      expect(step.textContent).toContain("Stale project 2");
      vi.unstubAllGlobals();
    });

    it("says so when a pause fails, and leaves the project in the list", async () => {
      context = {
        ...baseContext,
        state: buildState({ projects: staleProjects(1) }),
        saveProjectCommand: vi.fn(() => Promise.reject(new Error("This record changed elsewhere.")))
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      });
      expect(screen.getByRole("alert").textContent).toBe("This record changed elsewhere.");
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    });

    it("puts a dropped project back with Undo, as a restore at the version the close left", async () => {
      context = {
        ...baseContext,
        state: buildState({ projects: staleProjects(1) }),
        saveProjectCommand: vi.fn(() => Promise.resolve())
      };
      closeEntityCommand.mockClear();
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Drop" }));
      });
      expect(screen.getByRole("status").textContent).toContain("Dropped Stale project 1.");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      const bodies = closeEntityCommand.mock.calls.map(([command]) => closeEntityCommandSchema.parse(command));
      expect(bodies.map((body) => body.do)).toEqual(["close", "restore"]);
      expect(bodies[1]).toMatchObject({ type: "project", id: "stale-0", verb: "cancel", expectedVersion: 4 });
      expect(context.saveProjectCommand).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("asks before dropping a project that still has open actions, and closes them with it on Close all", async () => {
      context = { ...baseContext, state: buildState({ projects: staleProjects(1) }) };
      closeEntityCommand.mockClear();
      const refusal = childrenOpenRefusal({
        type: "project",
        id: "stale-0",
        verb: "cancel",
        version: 3,
        count: 2,
        deadlined: ["Tax return"]
      });
      closeEntityCommand.mockRejectedValueOnce(
        new CommandRefusal(refusal.message, { status: 400, nextCall: refusal.nextCall })
      );
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Drop" }));
      });
      expect(screen.getByText(/still has 2 open items under it, with deadlines: "Tax return"/)).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close all" }));
      });
      const bodies = closeEntityCommand.mock.calls.map(([command]) => closeEntityCommandSchema.parse(command));
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toMatchObject({ includeChildren: true });
      expect(bodies[1]!.commandId).toBe(bodies[0]!.commandId);
      expect(screen.getByRole("status").textContent).toContain("Dropped Stale project 1.");
    });

    it("keeps the project open when the question is declined", async () => {
      context = { ...baseContext, state: buildState({ projects: staleProjects(1) }) };
      closeEntityCommand.mockClear();
      const refusal = childrenOpenRefusal({
        type: "project",
        id: "stale-0",
        verb: "cancel",
        version: 3,
        count: 1,
        deadlined: []
      });
      closeEntityCommand.mockRejectedValueOnce(
        new CommandRefusal(refusal.message, { status: 400, nextCall: refusal.nextCall })
      );
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Drop" }));
      });
      fireEvent.click(screen.getByRole("button", { name: "Keep open" }));
      expect(screen.queryByText(/still has 1 open item/)).toBeNull();
      expect(closeEntityCommand).toHaveBeenCalledTimes(1);
    });
  });

  it("lists what agents are waiting on, with confirm and decline, above the agent changes", async () => {
    resetAgentProposals();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              String(url).startsWith("/api/agent-proposals")
                ? {
                    proposals: [
                      {
                        id: "p1",
                        agent: "openclaw",
                        kind: "entity_command",
                        summary: "Change settings",
                        payload: {},
                        basis: "inferred",
                        evidence: null,
                        targetVersions: {},
                        status: "pending",
                        coalesceKey: null,
                        revision: 1,
                        createdAt: now.toISOString(),
                        updatedAt: now.toISOString(),
                        resolvedAt: null,
                        resolvedBy: null,
                        resolutionNote: null
                      }
                    ]
                  }
                : { changes: [] }
            )
        })
      )
    );
    await act(async () => {
      await refreshAgentProposals();
    });
    context = { ...baseContext, state: buildState() };
    render(<ReviewPage />);
    expect(screen.getByRole("heading", { name: "From agents" })).toBeTruthy();
    expect(screen.getByText("Change settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm/ })).toBeTruthy();
    vi.unstubAllGlobals();
    resetAgentProposals();
  });

  describe("step 1 can finish", () => {
    const quiet = () =>
      buildState({
        projects: seed.projects.map((project) => ({ ...project, lastWorkedAt: now.toISOString() })),
        actions: seed.actions.map((action) => ({ ...action, status: "active" as const }))
      });

    it("folds waiting and blocked actions into a collapsed group that does not count", () => {
      const base = quiet();
      const state = {
        ...base,
        actions: [
          { ...base.actions[0]!, status: "waiting" as const },
          { ...base.actions[1]!, id: "blocked-one", status: "blocked" as const }
        ]
      };
      context = { ...baseContext, state };
      const { container } = render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Clear blockers/ }).textContent).toContain("(done)");
      const group = container.querySelector("details")!;
      expect(group.open).toBe(false);
      expect(group.querySelector("summary")!.textContent).toBe("Waiting on others (2)");
    });

    const overdueForecast = (projectId: string) =>
      ({
        projectId,
        overdue: true,
        proposal: {
          kind: "move_deadline",
          deadlineOwner: "internal",
          missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
          earliestFeasibleAt: new Date("2026-09-03T04:00:00.000Z")
        }
      }) as unknown as (typeof baseContext)["forecasts"][number];

    it("marks an overdue project seen, stored on the server through the confirm command", async () => {
      const state = quiet();
      const confirm = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: { ...state, projects: state.projects.map((project) => ({ ...project, version: 4 })) },
        forecasts: [overdueForecast(seed.projects[0]!.id)],
        confirmProjectWantedCommand: confirm
      };
      render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Clear blockers/ }).textContent).not.toContain("(done)");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Seen, leave it" }));
      });
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: seed.projects[0]!.id, expectedVersion: 4, kind: "overdue_seen" })
      );
      expect(screen.getByRole("status").textContent).toContain("for this week");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(confirm.mock.calls[1]![0]).toMatchObject({
        projectId: seed.projects[0]!.id,
        kind: "overdue_seen",
        reviewedAt: null
      });
      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("says so, and sends nothing, when Seen is pressed on a project that has no version yet", async () => {
      const state = quiet();
      const confirm = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: {
          ...state,
          projects: state.projects.map(({ version: _version, ...project }) => project) as typeof state.projects
        },
        forecasts: [overdueForecast(seed.projects[0]!.id)],
        confirmProjectWantedCommand: confirm
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Seen, leave it" }));
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain("has not been saved yet");
    });

    it("does not count an overdue project seen this review week, but asks again next week", () => {
      const state = quiet();
      const seen = (overdueSeenAt: string) => ({
        ...state,
        projects: state.projects.map((project) =>
          project.id === seed.projects[0]!.id ? { ...project, overdueSeenAt } : project
        )
      });
      // `now` is Sunday 30 Aug 2026, so the review week began on Monday 24 Aug.
      context = { ...baseContext, state: seen(now.toISOString()), forecasts: [overdueForecast(seed.projects[0]!.id)] };
      const view = render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Clear blockers/ }).textContent).toContain("(done)");
      view.unmount();
      context = {
        ...baseContext,
        state: seen("2026-08-20T00:00:00.000Z"),
        forecasts: [overdueForecast(seed.projects[0]!.id)]
      };
      render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Clear blockers/ }).textContent).not.toContain("(done)");
    });
  });

  describe("an ended series", () => {
    const ended = () => ({
      ...seed.actions[0]!,
      id: "reading-practice",
      title: "Read for 20 minutes",
      status: "active" as const,
      schedulingMode: "recurring" as const,
      recurrence: {
        id: "rule",
        actionId: "reading-practice",
        timezone: seed.settings.timezone,
        startDate: "2026-06-01",
        endDate: "2026-07-01",
        intervalDays: 1,
        windows: [],
        completionMode: "end_date" as const,
        accumulatedMinutes: 0
      }
    });

    it("extends from today when it ended long ago, says the new end date, and undoes it", async () => {
      const save = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: buildState({
          projects: seed.projects.map((project) => ({ ...project, lastWorkedAt: now.toISOString() })),
          actions: [...seed.actions, ended()]
        }),
        saveActionCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Extend 7 days" }));
      });
      const sent = save.mock.calls[0]![0] as { action: { recurrence: { endDate: string } } };
      // Today is 30 Aug; seven days on is in September, not 8 Jul (seven days from the old end).
      expect(sent.action.recurrence.endDate).toBe("2026-09-06");
      expect(screen.getByRole("status").textContent).toContain("Extended Read for 20 minutes to 6 Sept.");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      const undone = save.mock.calls[1]![0] as { action: { recurrence: { endDate: string } } };
      expect(undone.action.recurrence.endDate).toBe("2026-07-01");
    });

    it("says so when the extend fails", async () => {
      context = {
        ...baseContext,
        state: buildState({ actions: [...seed.actions, ended()] }),
        saveActionCommand: vi.fn(() => Promise.reject(new Error("Changed elsewhere.")))
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Extend 7 days" }));
      });
      expect(screen.getByRole("alert").textContent).toBe("Changed elsewhere.");
    });
  });
  describe("acts in place", () => {
    const quiet = () =>
      buildState({
        projects: seed.projects.map((project) => ({ ...project, version: 3, lastWorkedAt: now.toISOString() })),
        actions: seed.actions.map((action) => ({ ...action, status: "active" as const }))
      });
    // A save as the server applies it: the stored row takes the command's value, and the next render reads it.
    const ok = () =>
      vi.fn((command: unknown) => {
        const sent = command as {
          action?: { id: string; status: string };
          project?: { id: string; internalDeadlineAt?: string };
          entityType?: string;
          entity?: { id: string; status: string; reviewOn?: string };
        };
        const state = context.state;
        if (sent.action)
          context = {
            ...context,
            state: {
              ...state,
              actions: state.actions.map((item) =>
                item.id === sent.action!.id ? { ...item, status: sent.action!.status as never } : item
              )
            }
          };
        else if (sent.project)
          context = {
            ...context,
            state: {
              ...state,
              projects: state.projects.map((item) => {
                if (item.id !== sent.project!.id) return item;
                const { internalDeadlineAt: _old, ...rest } = item;
                return sent.project!.internalDeadlineAt
                  ? { ...rest, internalDeadlineAt: sent.project!.internalDeadlineAt }
                  : rest;
              })
            }
          };
        else if (sent.entityType === "outcome")
          context = {
            ...context,
            state: {
              ...state,
              outcomes: state.outcomes.map((item) => {
                if (item.id !== sent.entity!.id) return item;
                const { reviewOn: _old, ...rest } = item;
                return {
                  ...rest,
                  status: sent.entity!.status as never,
                  ...(sent.entity!.reviewOn ? { reviewOn: sent.entity!.reviewOn } : {})
                };
              })
            }
          };
        return Promise.resolve();
      });

    it("unblocks a stuck task by setting it to planned, and Undo puts the old status back", async () => {
      const base = quiet();
      const save = ok();
      context = {
        ...baseContext,
        state: {
          ...base,
          actions: [{ ...base.actions[0]!, version: 2, status: "waiting" as const }, ...base.actions.slice(1)]
        },
        saveActionCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({
        expectedVersion: 2,
        action: { id: base.actions[0]!.id, status: "planned" }
      });
      expect(screen.getByRole("status").textContent).toContain("Unblocked");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save.mock.calls[1]![0]).toMatchObject({ action: { status: "waiting" } });
    });

    it("marks a stuck task still waiting without saving anything", () => {
      const base = quiet();
      const save = ok();
      context = {
        ...baseContext,
        state: { ...base, actions: [{ ...base.actions[0]!, status: "blocked" as const }, ...base.actions.slice(1)] },
        saveActionCommand: save
      };
      render(<ReviewPage />);
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
      expect(screen.getByText(/skipped for now, not saved/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it("keeps a due outcome going four weeks on, and Undo restores its review date", async () => {
      const base = quiet();
      const save = ok();
      const outcome = { ...seed.outcomes[1]!, version: 5, reviewOn: "2026-08-01" };
      context = {
        ...baseContext,
        state: { ...base, outcomes: [seed.outcomes[0]!, outcome] },
        saveEntityCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({
        entityType: "outcome",
        expectedVersion: 5,
        entity: { id: outcome.id, status: "active", reviewOn: "2026-09-27" }
      });
      expect(screen.getByRole("status").textContent).toContain("Next review 27 Sept");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save.mock.calls[1]![0]).toMatchObject({ entity: { reviewOn: "2026-08-01" } });
    });

    it("puts back only the field it changed, so a change made elsewhere since is kept", async () => {
      const base = quiet();
      const save = ok();
      const outcome = { ...seed.outcomes[1]!, version: 5, reviewOn: "2026-08-01" };
      context = { ...baseContext, state: { ...base, outcomes: [seed.outcomes[0]!, outcome] }, saveEntityCommand: save };
      const { rerender } = render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      });
      // Another tab pauses the outcome and edits its title before Undo is pressed.
      const edited = { ...outcome, version: 7, reviewOn: "2026-09-27", status: "paused" as const, title: "Renamed" };
      context = { ...context, state: { ...base, outcomes: [seed.outcomes[0]!, edited] } };
      rerender(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save.mock.calls[1]![0]).toMatchObject({
        expectedVersion: 7,
        entity: { status: "paused", title: "Renamed", reviewOn: "2026-08-01" }
      });
    });

    it("leaves a field alone on Undo when another tab changed that same field", async () => {
      const base = quiet();
      const save = ok();
      const outcome = { ...seed.outcomes[1]!, version: 5, reviewOn: "2026-08-01" };
      context = { ...baseContext, state: { ...base, outcomes: [seed.outcomes[0]!, outcome] }, saveEntityCommand: save };
      const { rerender } = render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      });
      context = {
        ...context,
        state: {
          ...base,
          outcomes: [seed.outcomes[0]!, { ...outcome, version: 7, reviewOn: "2026-10-15" }]
        }
      };
      rerender(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert").textContent).toContain("was changed elsewhere");
      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("closes a due outcome as done, and Undo makes it active again", async () => {
      const base = quiet();
      const save = ok();
      const outcome = { ...seed.outcomes[1]!, version: 5, reviewOn: "2026-08-01" };
      context = { ...baseContext, state: { ...base, outcomes: [seed.outcomes[0]!, outcome] }, saveEntityCommand: save };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Close outcome" }));
      });
      expect(screen.getByRole("status").textContent).toContain("projects leave the plan");
      expect(save.mock.calls[0]![0]).toMatchObject({ entity: { id: outcome.id, status: "done" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save.mock.calls[1]![0]).toMatchObject({ entity: { status: "active", reviewOn: "2026-08-01" } });
    });

    it("says so when Keep going fails", async () => {
      const base = quiet();
      const outcome = { ...seed.outcomes[1]!, reviewOn: "2026-08-01" };
      context = {
        ...baseContext,
        state: { ...base, outcomes: [seed.outcomes[0]!, outcome] },
        saveEntityCommand: vi.fn(() => Promise.reject(new Error("Changed elsewhere.")))
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
      });
      expect(screen.getByRole("alert").textContent).toBe("Changed elsewhere.");
    });

    const overdue = (projectId: string, at: string) =>
      ({
        projectId,
        overdue: true,
        proposal: {
          kind: "move_deadline",
          deadlineOwner: "internal",
          missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z"),
          earliestFeasibleAt: new Date(at)
        }
      }) as unknown as (typeof baseContext)["forecasts"][number];

    it("accepts the date a card proposes, and Undo puts the earlier internal date back", async () => {
      const base = quiet();
      const save = ok();
      const projects = base.projects.map((project, index) =>
        index === 0 ? { ...project, internalDeadlineAt: "2026-08-17T08:00:00.000Z" } : project
      );
      context = {
        ...baseContext,
        state: { ...base, projects },
        forecasts: [overdue(projects[0]!.id, "2026-09-03T04:00:00.000Z")],
        saveProjectCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Accept 3 Sept" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({
        expectedVersion: 3,
        project: { id: projects[0]!.id, internalDeadlineAt: "2026-09-03T04:00:00.000Z" }
      });
      expect(screen.queryByRole("button", { name: "Move all (1)" })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save.mock.calls[1]![0]).toMatchObject({ project: { internalDeadlineAt: "2026-08-17T08:00:00.000Z" } });
    });

    it("offers Accept only for an external miss whose proposed day is not after the external date", async () => {
      const quietState = quiet();
      const base = {
        ...quietState,
        projects: quietState.projects.map((project, index) => ({
          ...project,
          externalDeadlineAt: index === 0 ? "2026-08-20T00:00:00.000Z" : "2027-01-01T00:00:00.000Z"
        }))
      };
      const external = (projectId: string, at: string) => {
        const forecast = overdue(projectId, at) as unknown as { proposal: { deadlineOwner: string } };
        forecast.proposal.deadlineOwner = "external";
        return forecast as unknown as (typeof baseContext)["forecasts"][number];
      };
      const save = ok();
      context = {
        ...baseContext,
        state: base,
        forecasts: [
          external(base.projects[0]!.id, "2026-09-03T04:00:00.000Z"),
          external(base.projects[1]!.id, "2026-09-05T04:00:00.000Z"),
          overdue(base.projects[1]!.id, "2026-09-05T04:00:00.000Z"),
          // An internal miss is held to the external ceiling too.
          overdue(base.projects[0]!.id, "2026-09-03T04:00:00.000Z")
        ],
        saveProjectCommand: save
      };
      render(<ReviewPage />);
      // Project 0 would land after its external date, so only project 1's two cards can be taken in place.
      expect(screen.getAllByRole("button", { name: /^Accept/ })).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Move all (2)" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Edit the date" })).toHaveLength(4);
      expect(screen.getAllByText(/Can't move past the external deadline/).length).toBeGreaterThan(0);
      expect(save).not.toHaveBeenCalled();
    });

    it("moves every overdue project at once, and Undo puts each back", async () => {
      const base = quiet();
      const save = ok();
      context = {
        ...baseContext,
        state: base,
        forecasts: [
          overdue(base.projects[0]!.id, "2026-09-03T04:00:00.000Z"),
          overdue(base.projects[1]!.id, "2026-09-05T04:00:00.000Z")
        ],
        saveProjectCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Move all (2)" }));
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status").textContent).toContain("Moved 2 projects");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(save).toHaveBeenCalledTimes(4);
    });

    it("opens the project editor in a sheet when a card has no date to accept", async () => {
      const base = quiet();
      context = {
        ...baseContext,
        state: base,
        forecasts: [
          {
            projectId: base.projects[0]!.id,
            overdue: true,
            proposal: {
              kind: "reduce_scope",
              deadlineOwner: "internal",
              missedDeadlineAt: new Date("2026-08-17T08:00:00.000Z")
            }
          } as unknown as (typeof baseContext)["forecasts"][number]
        ]
      };
      render(<ReviewPage />);
      expect(screen.queryByRole("button", { name: /^Accept/ })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit the date" }));
      });
      expect(screen.getByRole("dialog", { name: "Edit project" })).toBeTruthy();
    });
  });

  describe("step 3 and finishing", () => {
    const week = periodFor("weekly", now, seed.settings.timezone);
    const lastWeek = periodFor("weekly", new Date(now.getTime() - 7 * 86_400_000), seed.settings.timezone);
    const undatedProjects = () =>
      seed.projects.map((project) => {
        const { internalDeadlineAt: _i, externalDeadlineAt: _e, ...rest } = project;
        return { ...rest, version: 2, lastWorkedAt: now.toISOString() } as (typeof seed.projects)[number];
      });
    const stateWith = (planningFocus: (typeof seed)["planningFocus"]) =>
      buildState({
        projects: undatedProjects(),
        actions: seed.actions.map((action) => ({ ...action, status: "active" as const })),
        planningFocus
      });
    const record = (period: { start: string; end: string }, projectIds: string[], extra = {}) => ({
      id: `focus-${period.start}`,
      version: 1,
      kind: "weekly" as const,
      periodStart: period.start,
      periodEnd: period.end,
      projectIds,
      ...extra
    });

    it("keeps last week's focus in one tap", async () => {
      const projects = undatedProjects();
      const save = vi.fn((_command: unknown) => Promise.resolve());
      context = {
        ...baseContext,
        state: stateWith([record(lastWeek, [projects[0]!.id])]),
        saveEntityCommand: save
      };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Keep last week's focus (1)" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({
        entityType: "planning_focus",
        expectedVersion: null,
        entity: { kind: "weekly", periodStart: week.start, projectIds: [projects[0]!.id] }
      });
    });

    it("counts No focus this week as done once it is saved", async () => {
      const save = vi.fn((_command: unknown) => Promise.resolve());
      context = { ...baseContext, state: stateWith([]), saveEntityCommand: save };
      const { unmount } = render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Choose this week's undated focus/ }).textContent).not.toContain(
        "(done)"
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "No focus this week" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({ entity: { periodStart: week.start, projectIds: [] } });
      unmount();
      context = { ...baseContext, state: stateWith([record(week, [])]) };
      render(<ReviewPage />);
      expect(screen.getByRole("heading", { name: /^Choose this week's undated focus/ }).textContent).toContain(
        "(done)"
      );
      expect(screen.queryByRole("button", { name: "No focus this week" })).toBeNull();
    });

    it("offers Finish review once every step is clear, and saves today's date on the week's focus", async () => {
      const projects = undatedProjects();
      const save = vi.fn((_command: unknown) => Promise.resolve());
      context = { ...baseContext, state: stateWith([record(week, [projects[0]!.id])]), saveEntityCommand: save };
      render(<ReviewPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
      });
      expect(save.mock.calls[0]![0]).toMatchObject({
        expectedVersion: 1,
        entity: { periodStart: week.start, projectIds: [projects[0]!.id], reviewedOn: "2026-08-30" }
      });
    });

    it("says when the week was reviewed, and offers nothing more", () => {
      const projects = undatedProjects();
      context = { ...baseContext, state: stateWith([record(week, [projects[0]!.id], { reviewedOn: "2026-08-29" })]) };
      render(<ReviewPage />);
      expect(screen.getByText("Reviewed on 29 Aug.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Finish review" })).toBeNull();
    });

    it("does not offer Finish review while a step remains", () => {
      context = { ...baseContext, state: stateWith([]) };
      render(<ReviewPage />);
      expect(screen.queryByRole("button", { name: "Finish review" })).toBeNull();
    });
  });
});
