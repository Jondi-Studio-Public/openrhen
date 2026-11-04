// @vitest-environment jsdom
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { DayPlanItem, DayPlanWait } from "@/features/today/day-plan";
import { createSeedState, type StoredProject } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { DayPlanDetailSheet } from "./day-plan-detail-sheet";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
const projects = [{ id: "p1", title: "Thesis" }] as StoredProject[];
// None of the plain block tests below touch a commitment, so a bare seed state and a stub save are
// enough — only the disruption-lifecycle tests further down give the sheet anything to resolve.
const NOW = at("2026-08-19T02:00:00.000Z");
const state = createSeedState(NOW);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);

const planned: DayPlanItem = {
  id: "plan:a1:2026-08-19T02:30:00.000Z",
  kind: "planned",
  source: "engine",
  title: "Write the intro",
  subtitle: "45 focused min over 60 · At risk · self-set deadline",
  entityId: "a1",
  parentId: "p1",
  startsAt: at("2026-08-19T02:30:00.000Z"),
  endsAt: at("2026-08-19T03:30:00.000Z"),
  clippedStart: false,
  clippedEnd: false,
  minutes: 45,
  wallMinutes: 60,
  tier: "At risk · self-set deadline",
  reason: "Its margin is thin and nothing else is closer.",
  projected: true
};

const term = (label: string) =>
  [...document.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling?.textContent;

describe("DayPlanDetailSheet", () => {
  it("reads a projected block out: window, focused over wall-clock, project, tier and the engine's reason", () => {
    render(
      <DayPlanDetailSheet
        item={planned}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Projected" })).toBeTruthy();
    expect(term("Window")).toBe("12:30 pm–1:30 pm");
    expect(term("Minutes")).toBe("45 focused over 60");
    expect(term("Project")).toBe("Thesis");
    expect(term("Tier")).toBe("At risk · self-set deadline");
    expect(term("Why")).toBe("Its margin is thin and nothing else is closer.");
    expect(screen.getByText(/A projection from the current recommendation; it will move/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start now" }).getAttribute("href")).toBe("/");
  });

  it("says when the projection misses a latest safe start, and when it came from an old plan", () => {
    render(
      <DayPlanDetailSheet
        item={{ ...planned, displaced: true, stale: true }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/does not reach this before its latest safe start/)).toBeTruthy();
    expect(screen.getByText(/no longer current/)).toBeTruthy();
  });

  it("reads a leg out as a journey — how, how well known, and what it is for — and sends arriving to Now", () => {
    render(
      <DayPlanDetailSheet
        item={{
          id: "directive:travel:ctx-campus",
          kind: "travel",
          source: "engine",
          title: "Drive to Campus",
          subtitle: "18 min · then Assessment 2",
          entityId: "ctx-campus",
          startsAt: at("2026-08-19T03:30:00.000Z"),
          endsAt: at("2026-08-19T03:48:00.000Z"),
          clippedStart: false,
          clippedEnd: false,
          minutes: 18,
          toLocationId: "ctx-campus",
          mode: "car",
          travelSource: "measured",
          thenTitle: "Assessment 2",
          reason: "The journey is protected like the commitment's buffer."
        }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "The journey to make now" })).toBeTruthy();
    // The block's own window start, spelled out as the moment to leave rather than left implicit.
    expect(term("Leave by")).toBe("1:30 pm");
    expect(term("Leg")).toBe("Drive to Campus");
    expect(term("How")).toBe("by car");
    expect(term("Estimate")).toBe("measured");
    expect(term("For")).toBe("Assessment 2");
    // Wall clock throughout: eighteen minutes of journey, not eighteen focused minutes of anything.
    expect(term("Minutes")).toBe("18");
    expect(screen.getByText(/Arriving is recorded on Now/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Now to arrive" }).getAttribute("href")).toBe("/");
  });

  it("says a projected leg's length is stated but its provenance is not", () => {
    render(
      <DayPlanDetailSheet
        item={{
          id: "plan:travel:2026-08-19T06:00:00.000Z",
          kind: "travel",
          source: "engine",
          title: "Drive home",
          entityId: "ctx-home",
          startsAt: at("2026-08-19T06:00:00.000Z"),
          endsAt: at("2026-08-19T06:20:00.000Z"),
          clippedStart: false,
          clippedEnd: false,
          minutes: 20,
          projected: true
        }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "A journey the projected day makes" })).toBeTruthy();
    expect(term("Leave by")).toBe("4:00 pm");
    expect(term("How")).toBe("however you get there");
    expect(term("Estimate")).toBe("not stated for a projected leg");
    expect(term("For")).toBe("nothing in particular; the leg is the plan");
  });

  it("keeps the live directive's own wording, and offers Open Now rather than Start now", () => {
    render(
      <DayPlanDetailSheet
        item={{ ...planned, kind: "directive", projected: false, id: "directive:action:a1" }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Planned for you" })).toBeTruthy();
    expect(screen.getByText(/What to do right now, shown for its full length/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Now" }).getAttribute("href")).toBe("/");
  });

  it("names the members of a folded run, which the block itself has no room to list", () => {
    render(
      <DayPlanDetailSheet
        item={{
          ...planned,
          kind: "routine_step",
          source: "fixed",
          title: "Before Work · 3 steps",
          grouped: true,
          steps: [
            {
              id: "s1",
              title: "Eat breakfast",
              startsAt: at("2026-08-19T02:30:00.000Z"),
              endsAt: at("2026-08-19T02:40:00.000Z")
            },
            {
              id: "s2",
              title: "Get drink bottle",
              startsAt: at("2026-08-19T02:45:00.000Z"),
              endsAt: at("2026-08-19T02:50:00.000Z")
            },
            {
              id: "s3",
              title: "Brush teeth",
              startsAt: at("2026-08-19T03:00:00.000Z"),
              endsAt: at("2026-08-19T03:05:00.000Z")
            }
          ]
        }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    const steps = screen.getByRole("list", { name: "Steps in this block" });
    expect([...steps.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
      "Eat breakfast · 12:30 pm",
      "Get drink bottle · 12:45 pm",
      "Brush teeth · 1:00 pm"
    ]);
  });
});

/**
 * Preparation is the one thing this sheet records, and the reason the Preparation panel could leave
 * Today: ticking tomorrow morning's prep the night before is carrying the day out, not shaping it.
 */
describe("DayPlanDetailSheet on a preparation step", () => {
  const step: DayPlanItem = {
    id: "routine_step:drive",
    kind: "routine_step",
    source: "fixed",
    title: "Drive to College",
    subtitle: "Before Class · 30 min",
    entityId: "drive",
    parentId: "class",
    startsAt: at("2026-08-19T02:30:00.000Z"),
    endsAt: at("2026-08-19T03:00:00.000Z"),
    clippedStart: false,
    clippedEnd: false,
    minutes: 30
  };
  const sheet = (props: Partial<Parameters<typeof DayPlanDetailSheet>[0]> = {}) =>
    render(
      <DayPlanDetailSheet
        item={step}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
        {...props}
      />
    );

  it("names the step for what it is and hands over to the commitment that owns it", () => {
    sheet();
    expect(screen.getByRole("heading", { name: "A preparation step" })).toBeTruthy();
    expect(screen.getByText(/Preparation the planner placed against its commitment/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open commitment" }).getAttribute("href")).toBe("/commitments/class");
    // The commitment, not Now: the step's own page is where what it is can actually be changed.
    expect(screen.queryByRole("link", { name: "Open Now" })).toBeNull();
  });

  it("offers no Mark as done when the host cannot save", () => {
    sheet();
    expect(screen.queryByRole("button", { name: "Mark as done" })).toBeNull();
  });

  it("keeps marking done behind a confirmation, and does nothing if it is refused", () => {
    const onMarkDone = vi.fn().mockResolvedValue(undefined);
    sheet({ onMarkDone });
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    expect(onMarkDone).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm mark as done?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onMarkDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeTruthy();
  });

  it("hands the step back and closes once the confirmation is taken, since a done step leaves the day", async () => {
    const onMarkDone = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    sheet({ onMarkDone, onClose });
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, mark as done" }));
    await vi.waitFor(() => expect(onMarkDone).toHaveBeenCalledTimes(1));
    expect(onMarkDone.mock.calls[0]![0]).toMatchObject({ entityId: "drive", parentId: "class" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the reason and stays open when the save is rejected", async () => {
    const onMarkDone = vi.fn().mockRejectedValue(new Error("This routine step changed. Reload before starting."));
    const onClose = vi.fn();
    sheet({ onMarkDone, onClose });
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, mark as done" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This routine step changed. Reload before starting.");
    expect(onClose).not.toHaveBeenCalled();
  });

  // One sheet serves the whole day, so a confirmation aimed at last night's step must not still be
  // standing when the next block opens it.
  it("clears a standing confirmation when a different block opens the sheet", () => {
    const onMarkDone = vi.fn().mockResolvedValue(undefined);
    const { rerender } = sheet({ onMarkDone });
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    expect(screen.getByText("Confirm mark as done?")).toBeTruthy();
    rerender(
      <DayPlanDetailSheet
        item={{ ...step, id: "routine_step:brush", entityId: "brush", title: "Brush teeth" }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
        onMarkDone={onMarkDone}
      />
    );
    expect(screen.queryByText("Confirm mark as done?")).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeTruthy();
  });
});

/**
 * The one exception to "a commitment block sends you to its own page" (see `today/page.tsx`'s
 * `selectDayPlanItem`): an open-ended disruption opens here instead, because "Done, heading home"
 * and "Still out" only make sense while it is still under way.
 */
describe("DayPlanDetailSheet on an open-ended disruption commitment", () => {
  const openEnded = {
    ...state.commitments[0]!,
    id: "drive-mum",
    version: 2,
    title: "Driving Mum to the shops",
    location: "Westfield",
    origin: "disruption",
    disruptionOpenEnded: true,
    startsAt: "2026-08-19T01:00:00.000Z",
    endsAt: "2026-08-19T04:00:00.000Z"
  } as (typeof state.commitments)[number];
  const block: DayPlanItem = {
    id: "commitment:drive-mum",
    kind: "commitment",
    source: "fixed",
    title: "Driving Mum to the shops",
    entityId: "drive-mum",
    startsAt: at("2026-08-19T01:00:00.000Z"),
    endsAt: at("2026-08-19T04:00:00.000Z"),
    clippedStart: false,
    clippedEnd: false
  };
  const withDisruption = { ...state, commitments: [...state.commitments, openEnded] } as typeof state;

  it("names the held-open end and offers both lifecycle buttons, ending it on click", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <DayPlanDetailSheet
        item={block}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={withDisruption}
        now={NOW}
        saveEntityCommand={save}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/held open until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done, heading home" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "commitment",
        expectedVersion: 2,
        entity: expect.objectContaining({
          id: "drive-mum",
          location: "Westfield",
          endsAt: NOW.toISOString(),
          disruptionOpenEnded: false
        })
      })
    );
  });

  it("extends by an hour on 'Still out' without ending it", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <DayPlanDetailSheet
        item={block}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={withDisruption}
        now={NOW}
        saveEntityCommand={save}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Still out — another hour" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: expect.objectContaining({ endsAt: "2026-08-19T05:00:00.000Z", disruptionOpenEnded: true })
      })
    );
  });

  it("offers neither button for an ordinary commitment block", () => {
    const ordinary = { ...openEnded, id: "ordinary", origin: "planned", disruptionOpenEnded: false };
    const withOrdinary = { ...state, commitments: [...state.commitments, ordinary] } as typeof state;
    render(
      <DayPlanDetailSheet
        item={{ ...block, id: "commitment:ordinary", entityId: "ordinary" }}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={withOrdinary}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Done, heading home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Still out — another hour" })).toBeNull();
  });
});

/**
 * The new item kinds and the wait-only view: each
 * gets its own title and microcopy, and a planned/directive/reserved/soft block whose target is an
 * action also carries "Latest safe start" from the one shared formatter.
 */
describe("DayPlanDetailSheet on the new day-plan-surfaces kinds", () => {
  const leaveBy: DayPlanItem = {
    id: "leave_by:dentist",
    kind: "leave_by",
    source: "engine",
    title: "Leave by 08:10 for Dentist",
    subtitle: "usually 22 min · allowing 28",
    entityId: "dentist",
    startsAt: at("2026-08-19T22:10:00.000Z"),
    endsAt: at("2026-08-19T22:10:00.000Z"),
    clippedStart: false,
    clippedEnd: false,
    marker: true
  };

  const startBy: DayPlanItem = {
    id: "start_by:wash",
    kind: "start_by",
    source: "engine",
    title: "Start Wash by 19:30",
    subtitle: "for Work 07:00",
    entityId: "wash",
    startsAt: at("2026-08-19T09:30:00.000Z"),
    endsAt: at("2026-08-19T09:30:00.000Z"),
    clippedStart: false,
    clippedEnd: false,
    marker: true
  };

  const soft: DayPlanItem = {
    id: "soft:gym",
    kind: "soft",
    source: "engine",
    title: "Gym",
    subtitle: "2 of 3 fit this week",
    entityId: "gym",
    parentId: "networking-assignment",
    startsAt: at("2026-08-19T04:00:00.000Z"),
    endsAt: at("2026-08-19T04:30:00.000Z"),
    clippedStart: false,
    clippedEnd: false
  };

  const wait: DayPlanWait = {
    id: "wait:wash",
    stepId: "wash",
    title: "Wash · ready 09:35",
    anchorTitle: "Work",
    running: false,
    startsAt: at("2026-08-19T09:05:00.000Z"),
    endsAt: at("2026-08-19T09:35:00.000Z")
  };

  it("names the leave-by marker and reads its When", () => {
    render(
      <DayPlanDetailSheet
        item={leaveBy}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "When to leave" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Leave by 08:10 for Dentist" })).toBeTruthy();
    expect(term("When")).toBe("8:10 am");
    expect(term("Why")).toBe("usually 22 min · allowing 28");
    expect(screen.getByText(/When you need to leave to make this commitment/)).toBeTruthy();
  });

  it("names the start-by marker and reads its When", () => {
    render(
      <DayPlanDetailSheet
        item={startBy}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "When to start" })).toBeTruthy();
    expect(term("When")).toBe("7:30 pm");
    expect(term("Why")).toBe("for Work 07:00");
    expect(screen.getByText(/latest this preparation step can start/)).toBeTruthy();
  });

  it("names a soft cadence placement and says it holds nothing", () => {
    render(
      <DayPlanDetailSheet
        item={soft}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Room for a cadence action" })).toBeTruthy();
    expect(term("Why")).toBe("2 of 3 fit this week");
    expect(screen.getByText(/not held for anyone/)).toBeTruthy();
  });

  it("opens a wait-only view when a waits-strip segment is tapped in place of a block", () => {
    render(
      <DayPlanDetailSheet
        item={null}
        chip={null}
        wait={wait}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Waiting on a step" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Wash · ready 09:35" })).toBeTruthy();
    expect(term("Window")).toBe("7:05 pm–7:35 pm");
    expect(term("Status")).toBe("projected");
    expect(screen.getByText(/A wait the projected day expects once its step is done/)).toBeTruthy();
  });

  it("says a running wait's step is done and there is nothing to act on", () => {
    render(
      <DayPlanDetailSheet
        item={null}
        chip={null}
        wait={{ ...wait, running: true }}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(term("Status")).toBe("running now");
    expect(screen.getByText(/its wait is running now; nothing to act on until it ends/)).toBeTruthy();
  });

  it("shows Latest safe start on a planned block whose target the forecast knows", () => {
    const action = {
      ...state.actions[0]!,
      id: "networking-section-one",
      projectId: "networking-assignment"
    };
    const withAction = { ...state, actions: [action, ...state.actions.slice(1)] } as typeof state;
    const forecast: ClientForecast = {
      projectId: "networking-assignment",
      health: "at_risk",
      protectedRemainingMinutes: null,
      pessimisticRemainingMinutes: null,
      compatibleCapacityMinutes: null,
      grossCompatibleCapacityMinutes: null,
      reservedByEarlierDeadlinesMinutes: 0,
      requiredPaceMinutesPerWeek: null,
      forecastBand: null,
      confidence: null,
      forecastThrough: at("2026-08-25T00:00:00.000Z"),
      expectedMarginMinutes: null,
      pessimisticMarginMinutes: null,
      marginRatio: null,
      scheduleVariance: null,
      unallocatedExpectedMinutes: 0,
      latestSafeStarts: { "networking-section-one": at("2026-08-20T08:00:00.000Z") },
      reasons: []
    };
    render(
      <DayPlanDetailSheet
        item={{ ...planned, entityId: "networking-section-one", parentId: "networking-assignment" }}
        chip={null}
        timezone={TZ}
        projects={[...projects, { id: "networking-assignment", title: "Networking assignment" } as StoredProject]}
        state={withAction}
        now={NOW}
        forecasts={[forecast]}
        detailedEndsAt={at("2026-08-22T00:00:00.000Z")}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(term("Latest safe start")).toBe("Thu 6:00 pm");
  });

  it("says nothing about Latest safe start when the forecast has no entry for the target", () => {
    render(
      <DayPlanDetailSheet
        item={planned}
        chip={null}
        timezone={TZ}
        projects={projects}
        state={state}
        now={NOW}
        forecasts={[]}
        saveEntityCommand={saveEntityCommand}
        onClose={() => {}}
      />
    );
    expect(screen.queryByText("Latest safe start")).toBeNull();
  });

  describe("snoozing a placed action", () => {
    const action = { ...state.actions[0]!, id: "a1", schedulingMode: "one_off" as const };
    const withAction = { ...state, actions: [action, ...state.actions.slice(1)] };
    const mount = (
      onSnooze: Mock<(actionId: string, availableFrom: string) => Promise<void>>,
      item: DayPlanItem = planned
    ) =>
      render(
        <DayPlanDetailSheet
          item={item}
          chip={null}
          timezone={TZ}
          projects={projects}
          state={withAction}
          now={NOW}
          saveEntityCommand={saveEntityCommand}
          onClose={() => {}}
          onSnooze={onSnooze}
        />
      );

    it("offers the same chips and sets the start of tomorrow in the plan zone", () => {
      const onSnooze = vi.fn<(actionId: string, availableFrom: string) => Promise<void>>().mockResolvedValue(undefined);
      mount(onSnooze);
      expect(screen.getByRole("button", { name: "Next week" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Pick a date" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
      // 12:00 pm Wednesday 19 Aug in the seed zone; tomorrow starts 2026-08-20T00:00 +10:00.
      expect(onSnooze).toHaveBeenCalledWith("a1", "2026-08-19T14:00:00.000Z");
    });

    it("offers nothing on a block that is not an action's placement", () => {
      mount(vi.fn<(actionId: string, availableFrom: string) => Promise<void>>(), { ...planned, kind: "reserved" });
      expect(screen.queryByRole("button", { name: "Tomorrow" })).toBeNull();
    });
  });
});
