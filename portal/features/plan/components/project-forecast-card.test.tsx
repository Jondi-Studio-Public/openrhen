// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState, type StoredAction, type StoredProject } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { deliverable, session } from "@/features/deliverables/test-fixtures";
import { ProjectForecastCard } from "@/features/plan/components/project-forecast-card";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const project = (overrides: Partial<StoredProject> = {}): StoredProject => ({ ...seed().projects[1]!, ...overrides });
const action = (overrides: Partial<StoredAction> = {}): StoredAction => ({ ...seed().actions[1]!, ...overrides });
const forecast = (overrides: Partial<ClientForecast> = {}): ClientForecast => ({
  projectId: "clean-room",
  health: "at_risk",
  protectedRemainingMinutes: 120,
  pessimisticRemainingMinutes: 180,
  compatibleCapacityMinutes: 90,
  grossCompatibleCapacityMinutes: 150,
  reservedByEarlierDeadlinesMinutes: 60,
  requiredPaceMinutesPerWeek: 45,
  forecastBand: "weekly",
  confidence: "low",
  forecastThrough: new Date("2026-09-01T00:00:00.000Z"),
  expectedMarginMinutes: -30,
  pessimisticMarginMinutes: -90,
  marginRatio: -0.2,
  scheduleVariance: -0.1,
  unallocatedExpectedMinutes: 0,
  latestSafeStarts: {},
  reasons: [],
  ...overrides
});

describe("ProjectForecastCard", () => {
  it("labels each forecast figure in plain words and explains it in a tooltip", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    for (const text of [
      "of work left",
      "free before deadline",
      "for earlier deadlines",
      "left for this",
      "a week needed",
      "set aside later"
    ])
      expect(screen.getByText(text).parentElement?.getAttribute("title")).toMatch(/^[A-Z].*\.$/);
    expect(screen.queryByText("protected min")).toBeNull();
  });

  it("leaves out figures that are null rather than showing 0 min", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({
          protectedRemainingMinutes: null,
          compatibleCapacityMinutes: null,
          grossCompatibleCapacityMinutes: null,
          requiredPaceMinutesPerWeek: null
        })}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    for (const text of ["of work left", "free before deadline", "left for this", "a week needed"])
      expect(screen.queryByText(text)).toBeNull();
  });

  it("says the deadline is missing rather than inventing one", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("No deadline set · Days 15–30 · by week")).toBeTruthy();
    expect(screen.getByText("at risk · low confidence")).toBeTruthy();
  });

  it("shows a manual override beside the action estimates it overrules", () => {
    render(
      <ProjectForecastCard
        project={project({ remainingEffortOverrideMinutes: 240 })}
        forecast={forecast()}
        actions={[action({ remainingMinutes: 45 }), action({ id: "second", remainingMinutes: 15 })]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("Manual project override: 4.0 hr")).toBeTruthy();
    expect(screen.getByText("Current action estimates: 60 min. The override is authoritative.")).toBeTruthy();
  });

  it("explains an absent envelope only while the forecast is actually known", () => {
    const { rerender } = render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(
      screen.getByText("Nothing set aside after week one: its time is booked at exact times in the first 7 days.")
    ).toBeTruthy();
    rerender(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ health: "unknown" })}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(
      screen.queryByText("Nothing set aside after week one: its time is booked at exact times in the first 7 days.")
    ).toBeNull();
  });

  it("shows an action's latest safe start from the shared formatter, prefixed 'latest' only when exact", () => {
    const { rerender } = render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ latestSafeStarts: { "room-floor": new Date("2026-08-20T08:00:00.000Z") } })}
        actions={[action()]}
        envelopes={[]}
        detailedEndsAt={new Date("2026-08-22T00:00:00.000Z")}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    // Exact (inside the detailed band): prefixed "latest", the same weekday-and-time wording
    // `latestSafeStartText` gives everywhere else it is used.
    expect(screen.getByText(/· latest Thu 6:00 pm/)).toBeTruthy();
    // At or after the detailed band's own end: "around <date>", no "latest" prefix.
    rerender(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ latestSafeStarts: { "room-floor": new Date("2026-08-20T08:00:00.000Z") } })}
        actions={[action()]}
        envelopes={[]}
        detailedEndsAt={new Date("2026-08-19T00:00:00.000Z")}
        timezone="Australia/Sydney"
        now={new Date("2026-08-11T00:00:00.000Z")}
        onEdit={() => {}}
      />
    );
    // Inside about six weeks the date reads "Thu 20 Aug", with no year.
    expect(screen.getByText(/· around Thu 20 Aug$/)).toBeTruthy();
    // Unplaced: the formatter's own wording, still no "latest" prefix.
    rerender(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ unplacedUnitIds: ["room-floor"] })}
        actions={[action()]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText(/· can't be placed before the deadline/)).toBeTruthy();
  });

  it("hands the whole project back when its editor is opened", () => {
    const onEdit = vi.fn();
    const item = project();
    render(
      <ProjectForecastCard
        project={item}
        forecast={undefined}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit project" }));
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it("shows the derived pace percentages under the chip when present", () => {
    render(
      <ProjectForecastCard
        project={project({ actualCompletionRatio: 0.4, requiredCompletionRatio: 0.25 })}
        forecast={forecast()}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("40% done · 25% of time used")).toBeTruthy();
  });

  it("shows no pace line at all when the ratios have not been derived", () => {
    render(
      <ProjectForecastCard
        project={project({ actualCompletionRatio: undefined, requiredCompletionRatio: undefined })}
        forecast={forecast()}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.queryByText(/done ·/)).toBeNull();
    expect(screen.queryByText(/% of time used/)).toBeNull();
  });

  it("shows overdue outright when health could not otherwise be forecast", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ health: "unknown", overdue: true })}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("overdue · low confidence")).toBeTruthy();
    expect(screen.queryByText("not forecast · low confidence")).toBeNull();
  });

  it("appends overdue to a health that already reads as behind", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({ health: "behind", overdue: true })}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("behind · overdue · low confidence")).toBeTruthy();
  });

  it("keeps its actions behind a disclosure and leaves the row bare with no handlers offered", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[action()]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("Actions (1)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("lists done actions at the end of the disclosure, marked done, and still editable", () => {
    const onEditAction = vi.fn();
    const live = action({ id: "live", title: "Live action" });
    const done = action({ id: "done-one", title: "Done action", status: "done", remainingMinutes: 20 });
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[live]}
        doneActions={[done]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onEditAction={onEditAction}
      />
    );
    // The math-facing count in the summary stays over the non-done actions only.
    expect(screen.getByText("Actions (1)")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Live action");
    expect(rows[1]!.textContent).toContain("Done action");
    expect(rows[1]!.textContent).toContain("done · 20 min");
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[1]!);
    expect(onEditAction).toHaveBeenCalledWith(done);
  });

  it("edits the action a row's Edit button was pressed for", () => {
    const onEditAction = vi.fn();
    const item = action();
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[item]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onEditAction={onEditAction}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEditAction).toHaveBeenCalledWith(item);
  });

  it("marks the remaining effort and energy an action lists as assumed, and nothing else", () => {
    const assumed = action({ id: "guess", title: "Guessed action", assumedFields: ["remainingMinutes", "energy"] });
    const sure = action({ id: "sure", title: "Sure action", assumedFields: ["importance"] });
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[assumed, sure]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain(
      `${assumed.remainingMinutes} min (assumed) · ${assumed.energy} focus (assumed)`
    );
    expect(rows[1]!.textContent).toContain(`${sure.remainingMinutes} min · ${sure.energy} focus`);
    expect(rows[1]!.textContent).not.toContain("assumed");
  });

  it("offers to end a goal-based series but never a dated one", () => {
    const onEndRecurrenceGoal = vi.fn();
    const recurring = action({
      schedulingMode: "recurring",
      recurrence: {
        id: "rule",
        actionId: "room-floor",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        endDate: "2026-10-01",
        intervalDays: 1,
        completionMode: "end_date",
        accumulatedMinutes: 0,
        windows: []
      }
    });
    const { rerender } = render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[recurring]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onEndRecurrenceGoal={onEndRecurrenceGoal}
      />
    );
    expect(screen.queryByRole("button", { name: "Mark goal complete" })).toBeNull();
    const goalBased = action({
      schedulingMode: "recurring",
      recurrence: {
        ...recurring.recurrence!,
        completionMode: "manual",
        endDate: undefined
      }
    });
    rerender(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[goalBased]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onEndRecurrenceGoal={onEndRecurrenceGoal}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark goal complete" }));
    expect(onEndRecurrenceGoal).toHaveBeenCalledWith(goalBased);
  });

  it("offers to tick off today's cadence until it has been done today", () => {
    const onRecordCadenceCompletion = vi.fn();
    const now = new Date("2026-08-18T09:00:00.000Z");
    const practice = action({
      schedulingMode: "cadence",
      recurrence: {
        id: "rule",
        actionId: "room-floor",
        timezone: "Australia/Sydney",
        startDate: "2026-08-01",
        intervalDays: 3,
        completionMode: "manual",
        accumulatedMinutes: 0,
        windows: [],
        lastCompletedLocalDate: "2026-08-15"
      }
    });
    const { rerender } = render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[practice]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onRecordCadenceCompletion={onRecordCadenceCompletion}
        now={now}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Done today" }));
    expect(onRecordCadenceCompletion).toHaveBeenCalledWith(practice);
    const done = action({
      schedulingMode: "cadence",
      recurrence: { ...practice.recurrence!, lastCompletedLocalDate: "2026-08-18" }
    });
    rerender(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[done]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onRecordCadenceCompletion={onRecordCadenceCompletion}
        now={now}
      />
    );
    expect(screen.queryByRole("button", { name: "Done today" })).toBeNull();
  });

  it("lists a project's deliverables as enterable links rather than their own disclosure", () => {
    const item = deliverable({ id: "assessment-2", projectId: "clean-room", title: "Assessment 2" });
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[]}
        deliverables={[item]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("1 deliverable")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Assessment 2/ });
    expect(link.getAttribute("href")).toBe("/deliverables?deliverable=assessment-2");
    // Only the project-level disclosure exists — the deliverable row itself is a plain link, not a
    // disclosure of its own, so entering it never expands anything in place.
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("groups standalone actions under their own nested Actions disclosure once the project has deliverables", () => {
    const onEditAction = vi.fn();
    const item = deliverable({ id: "assessment-2", projectId: "clean-room" });
    const itemAction = action();
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[itemAction]}
        deliverables={[item]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
        onEditAction={onEditAction}
      />
    );
    expect(screen.getByText("1 deliverable · 1 action")).toBeTruthy();
    expect(screen.getByText("Actions (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEditAction).toHaveBeenCalledWith(itemAction);
  });

  it("shows a closed deliverable's real status and an in-session one as live", () => {
    const closed = deliverable({ id: "closed-one", projectId: "clean-room", title: "Old draft", status: "completed" });
    const inSession = deliverable({ id: "assessment-2", projectId: "clean-room", title: "Assessment 2" });
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast()}
        actions={[]}
        deliverables={[closed, inSession]}
        activeSession={session()}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("In session")).toBeTruthy();
  });

  it("shows a maintenance project's real adherence health and per-action breakdown, not the engine's unknown", () => {
    const stretching = action({ id: "stretching-action", title: "Stretching" });
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({
          health: "unknown",
          overdue: false,
          healthBasis: "adherence",
          forecastBand: null,
          adherence: {
            health: "behind",
            ratio: 0.4,
            actions: [
              {
                actionId: "stretching-action",
                done: 2,
                expectedSoFar: 5,
                target: 10,
                periodLabel: "this 10-day period"
              }
            ]
          },
          reasons: ["Adherence 2 of 5 due so far this 10-day period; Stretching is 3 behind."]
        })}
        actions={[stretching]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    // The chip reads the real adherence classification, not the engine's top-level "unknown".
    expect(screen.getByText("behind · low confidence")).toBeTruthy();
    expect(screen.queryByText("not forecast · low confidence")).toBeNull();
    expect(
      screen.getByText("Maintenance project · health tracks whether you keep up with it, not a deadline")
    ).toBeTruthy();
    expect(screen.getByText("Stretching: 2 of 5 due this 10-day period (target 10)")).toBeTruthy();
  });

  it("falls back to the action id when a per-action adherence detail names no matching action", () => {
    render(
      <ProjectForecastCard
        project={project()}
        forecast={forecast({
          health: "unknown",
          healthBasis: "adherence",
          adherence: {
            health: "on_track",
            ratio: 1,
            actions: [{ actionId: "missing-action", done: 1, expectedSoFar: 1, target: 1, periodLabel: "today" }]
          }
        })}
        actions={[]}
        envelopes={[]}
        timezone="Australia/Sydney"
        onEdit={() => {}}
      />
    );
    expect(screen.getByText("missing-action: 1 of 1 due today (target 1)")).toBeTruthy();
  });
});
