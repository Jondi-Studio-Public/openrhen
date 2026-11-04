// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { SleepPlanEditor } from "./sleep-plan-editor";

const plan = (overrides: Record<string, unknown> = {}) => ({
  id: "night-one",
  status: "planned",
  plannedStartAt: "2026-08-18T12:00:00.000Z",
  plannedWakeAt: "2026-08-18T20:00:00.000Z",
  allowedMinutes: 480,
  targetMinutes: 480,
  explanation: "Full night available",
  hardErrors: [],
  ...overrides
});

const buildState = (overrides: Record<string, unknown> = {}): PortalState =>
  ({
    settings: { timezone: "Australia/Sydney", lastWokeAt: "2026-08-18T20:00:00.000Z" },
    commitments: [],
    sleepPlans: [plan()],
    ...overrides
  }) as unknown as PortalState;

describe("Seven-day sleep plan editor", () => {
  it("asks for a last-woke time before it will plan sleep safely", () => {
    render(
      <SleepPlanEditor state={buildState({ settings: { timezone: "Australia/Sydney" } })} saveEntityCommand={vi.fn()} />
    );
    expect(screen.getByText("Add when you last woke in Settings before sleep can be planned safely.")).toBeTruthy();
  });

  it("explains a planned night and its shortfall", () => {
    render(
      <SleepPlanEditor
        state={buildState({
          sleepPlans: [
            plan({
              allowedMinutes: 300,
              targetMinutes: 480,
              minimumShortfallMinutes: 60,
              wakeConstraint: { title: "Early exam" }
            })
          ]
        })}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByText(/5h planned of 8h target · Full night available/)).toBeTruthy();
    expect(screen.getByText(/60 minutes short because of Early exam/)).toBeTruthy();
  });

  it("warns that a tentative commitment does not shorten protected sleep", () => {
    render(
      <SleepPlanEditor
        state={buildState({
          commitments: [
            {
              id: "maybe",
              title: "Late shift",
              status: "tentative",
              startsAt: "2026-08-18T14:00:00.000Z",
              endsAt: "2026-08-18T16:00:00.000Z",
              setupBeforeMinutes: 0,
              transitionAfterMinutes: 0
            }
          ]
        })}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByText(/Tentative commitment “Late shift” conflicts with protected sleep/)).toBeTruthy();
  });

  it("shows the planner's other hard errors without repeating the shortfall", () => {
    render(
      <SleepPlanEditor
        state={buildState({
          sleepPlans: [
            plan({
              minimumShortfallMinutes: 30,
              hardErrors: ["Minimum sleep cannot be met by 30 minutes", "Maximum awake time exceeded"]
            })
          ]
        })}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByText("Maximum awake time exceeded")).toBeTruthy();
    expect(screen.queryByText("Minimum sleep cannot be met by 30 minutes")).toBe(null);
  });

  it("opens an override form for the night being edited and saves it", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(<SleepPlanEditor state={buildState()} saveEntityCommand={saveEntityCommand} />);
    expect(screen.queryByRole("button", { name: "Save override" })).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Edit night" }));
    const start = screen.getByLabelText("Sleep starts") as HTMLInputElement;
    expect(start.value).toHaveLength(16);

    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    await vi.waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: "night-one" }
    });
  });
  it("warns when a night is placed well before bedtime, and answers the choice", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <SleepPlanEditor
        state={buildState({
          sleepPlans: [
            plan({
              deviationOptions: {
                early: { startsAt: "2026-08-18T05:00:00.000Z", wakesAt: "2026-08-18T20:00:00.000Z", minutes: 480 },
                near: { startsAt: "2026-08-18T15:00:00.000Z", wakesAt: "2026-08-18T20:00:00.000Z", minutes: 360 },
                warn: true
              }
            })
          ]
        })}
        saveEntityCommand={saveEntityCommand}
      />
    );
    expect(screen.getByText(/This night starts well before your usual bedtime/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep this night" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "sleep_plan",
        entity: { id: "night-one", placementChoice: "near" }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to bed early" }));
    expect(saveEntityCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ entity: { id: "night-one", placementChoice: "early" } })
    );
  });

  it("does not warn once a night no longer deviates", () => {
    render(<SleepPlanEditor state={buildState()} saveEntityCommand={vi.fn()} />);
    expect(screen.queryByText(/This night starts well before your usual bedtime/)).toBe(null);
  });

  it("links to the sleep log to correct a past night, instead of hosting that form itself", () => {
    render(<SleepPlanEditor state={buildState()} saveEntityCommand={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Correct a past night" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sleep");
  });

  it("is sheet content: no heading of its own, a way to edit each night, and a link to correct a past one", () => {
    render(<SleepPlanEditor state={buildState()} saveEntityCommand={vi.fn()} />);
    expect(screen.queryByRole("heading")).toBe(null);
    expect(screen.getByRole("button", { name: "Edit night" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Correct a past night" }).getAttribute("href")).toBe("/sleep");
  });

  it("opens the override form in a sheet on a phone and inline on a desk", () => {
    const { rerender } = render(<SleepPlanEditor state={buildState()} saveEntityCommand={vi.fn()} phone />);
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Edit night" }));
    const dialog = screen.getByRole("dialog", { name: "Edit night" });
    expect(dialog.querySelector(".editor-grid")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The sheet now animates out rather than vanishing on the same tick — it stays mounted through
    // its exit transition, so the close only finishes once that transition ends.
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBe(null);

    rerender(<SleepPlanEditor state={buildState()} saveEntityCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit night" }));
    expect(screen.queryByRole("dialog")).toBe(null);
    expect(screen.getByRole("button", { name: "Save override" })).toBeTruthy();
  });
});
