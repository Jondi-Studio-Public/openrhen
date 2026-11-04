// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import type { StoredSleepPlan } from "@/state/portal-state";
import { SleepLogList } from "./sleep-log-list";
import { deleteNight } from "@/features/sleep-log/sleep-log-command";

vi.mock("@/features/sleep-log/sleep-log-command", () => ({
  createNight: vi.fn(),
  updateNight: vi.fn(),
  deleteNight: vi.fn()
}));

const timezone = "Australia/Sydney";

function night(overrides: Partial<StoredSleepPlan> = {}): StoredSleepPlan {
  return {
    id: "night-one",
    version: 3,
    status: "completed",
    plannedStartAt: "2026-08-18T12:00:00.000Z",
    plannedWakeAt: "2026-08-18T20:00:00.000Z",
    actualStartAt: "2026-08-18T12:10:00.000Z",
    actualWakeAt: "2026-08-18T20:05:00.000Z",
    desiredMinutes: 480,
    allowedMinutes: 474,
    sleepDeficitMinutes: 0,
    anchorDeviationMinutes: 0,
    hardErrors: [],
    explanation: "",
    manual: false,
    ...overrides
  };
}

beforeEach(() => {
  vi.mocked(deleteNight).mockReset();
});

describe("SleepLogList", () => {
  it("shows the empty state and still offers to add a night", () => {
    render(<SleepLogList plans={[]} timezone={timezone} onChanged={vi.fn()} />);
    expect(
      screen.getByText("No nights recorded yet. Tracked sleep appears here automatically — add one you forgot below.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a night" })).toBeTruthy();
  });

  it("badges a night in progress as live, offers Edit, and never offers Delete", () => {
    render(
      <SleepLogList
        plans={[night({ status: "sleeping", manual: undefined })]}
        timezone={timezone}
        onChanged={vi.fn()}
      />
    );
    const badge = screen.getByText("Sleeping now");
    expect(badge.className).toBe("phase-pill live");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBe(null);
  });

  it("badges a completed, engine-tracked night as Tracked", () => {
    render(<SleepLogList plans={[night({ manual: false })]} timezone={timezone} onChanged={vi.fn()} />);
    const badge = screen.getByText("Tracked");
    expect(badge.className).toBe("phase-pill");
  });

  it("shows the actual-span duration, not the frozen planned allowance, for a completed tracked night", () => {
    // A night that ran long (16h) while allowedMinutes stayed at the 5h the plan was made for —
    // the exact staleness the backend now fixes on wake, and what this chip must not trust once
    // actual times are available.
    render(
      <SleepLogList
        plans={[
          night({
            actualStartAt: "2026-08-29T12:47:00.000Z",
            actualWakeAt: "2026-08-30T04:58:00.000Z",
            allowedMinutes: 300
          })
        ]}
        timezone={timezone}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("16.2h")).toBeTruthy();
    expect(screen.queryByText("5h")).toBe(null);
  });

  it("falls back to allowedMinutes for a night still in progress, which has no wake time yet", () => {
    render(
      <SleepLogList
        plans={[night({ status: "sleeping", allowedMinutes: 300, actualWakeAt: undefined })]}
        timezone={timezone}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText("5h")).toBeTruthy();
  });

  it("badges a hand-logged completed night as Logged", () => {
    render(<SleepLogList plans={[night({ manual: true })]} timezone={timezone} onChanged={vi.fn()} />);
    const badge = screen.getByText("Logged");
    expect(badge.className).toBe("phase-pill closed");
  });

  it("deletes a completed night only after a two-step confirmation", async () => {
    vi.mocked(deleteNight).mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(<SleepLogList plans={[night()]} timezone={timezone} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Confirm delete?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(screen.queryByText("Confirm delete?")).toBe(null);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(deleteNight).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await vi.waitFor(() => expect(deleteNight).toHaveBeenCalledWith("night-one", 3));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("surfaces a rejected delete inline and leaves the row in place", async () => {
    vi.mocked(deleteNight).mockRejectedValue(new Error("The night could not be removed right now."));
    const onChanged = vi.fn();
    render(<SleepLogList plans={[night()]} timezone={timezone} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The night could not be removed right now.");
    expect(onChanged).not.toHaveBeenCalled();
    // The row survives the failed delete — its edit action is still reachable.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("opens a night in progress for editing with only its start, no wake field and no delete inside", () => {
    render(<SleepLogList plans={[night({ status: "sleeping" })]} timezone={timezone} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit this night" });
    expect(within(dialog).getByLabelText("Sleep starts")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Wake time")).toBe(null);
    expect(within(dialog).queryByRole("button", { name: /delete/i })).toBe(null);
  });

  it("opens the add-a-night sheet empty of any existing night", () => {
    render(<SleepLogList plans={[]} timezone={timezone} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a night" }));
    expect(screen.getByRole("dialog", { name: "Add a night" })).toBeTruthy();
  });

  it("badges tonight's plan as Planned and a planned night the app never saw as Not recorded", () => {
    const ahead = new Date(Date.now() + 6 * 60 * 60_000);
    const past = new Date(Date.now() - 30 * 60 * 60_000);
    const plan = (id: string, start: Date) =>
      night({
        id,
        status: "planned",
        plannedStartAt: start.toISOString(),
        plannedWakeAt: new Date(start.getTime() + 8 * 60 * 60_000).toISOString(),
        actualStartAt: undefined,
        actualWakeAt: undefined,
        manual: undefined
      });
    render(
      <SleepLogList plans={[plan("tonight", ahead), plan("missed", past)]} timezone={timezone} onChanged={vi.fn()} />
    );
    expect(screen.getByText("Planned")).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Delete" })).toBe(null);
  });
});
