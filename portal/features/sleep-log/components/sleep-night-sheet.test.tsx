// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { StoredSleepPlan } from "@/state/portal-state";
import { SleepNightSheet } from "./sleep-night-sheet";
import { createNight, updateNight } from "@/features/sleep-log/sleep-log-command";

vi.mock("@/features/sleep-log/sleep-log-command", () => ({
  createNight: vi.fn(),
  updateNight: vi.fn(),
  deleteNight: vi.fn()
}));

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

// A planning zone no test machine runs in, so a picker that read the device's zone would fail.
const timezone = "Pacific/Auckland";

beforeEach(() => {
  vi.mocked(createNight).mockReset();
  vi.mocked(updateNight).mockReset();
});

describe("SleepNightSheet", () => {
  it("renders nothing while closed", () => {
    render(<SleepNightSheet timezone={timezone} open={false} plan={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("opens empty and titled to add a night when there is no existing plan", () => {
    render(<SleepNightSheet timezone={timezone} open plan={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Add a night" })).toBeTruthy();
    expect(screen.getByLabelText("Sleep starts")).toBeTruthy();
    expect(screen.getByLabelText("Wake time")).toBeTruthy();
  });

  it("prefills an existing night's actual times for editing", () => {
    render(<SleepNightSheet timezone={timezone} open plan={night()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Edit this night" })).toBeTruthy();
    const start = screen.getByLabelText("Sleep starts") as HTMLInputElement;
    const wake = screen.getByLabelText("Wake time") as HTMLInputElement;
    // 12:10Z and 20:05Z on the Auckland wall clock (NZST, +12).
    expect(start.value).toBe("2026-08-19T00:10");
    expect(wake.value).toBe("2026-08-19T08:05");
  });

  it("hides the wake field entirely for a night still in progress", () => {
    render(
      <SleepNightSheet
        timezone={timezone}
        open
        plan={night({ status: "sleeping" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Sleep starts")).toBeTruthy();
    expect(screen.queryByLabelText("Wake time")).toBe(null);
    expect(screen.getByText(/Still asleep/)).toBeTruthy();
  });

  it("nudges the start time by fifteen minutes in each direction with the steppers", () => {
    render(<SleepNightSheet timezone={timezone} open plan={night()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const start = screen.getByLabelText("Sleep starts") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Sleep starts, 15 minutes later" }));
    expect(start.value).toBe("2026-08-19T00:25");
    fireEvent.click(screen.getByRole("button", { name: "Sleep starts, 15 minutes earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Sleep starts, 15 minutes earlier" }));
    expect(start.value).toBe("2026-08-18T23:55");
  });

  it("nudges the wake time independently of the start time", () => {
    render(<SleepNightSheet timezone={timezone} open plan={night()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const wake = screen.getByLabelText("Wake time") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Wake time, 15 minutes later" }));
    expect(wake.value).toBe("2026-08-19T08:20");
  });

  it("creates a night from typed times and reports success upward", async () => {
    vi.mocked(createNight).mockResolvedValue(undefined);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SleepNightSheet timezone={timezone} open plan={null} onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Sleep starts"), { target: { value: "2026-08-18T22:00" } });
    fireEvent.change(screen.getByLabelText("Wake time"), { target: { value: "2026-08-19T06:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save night" }));
    await vi.waitFor(() => expect(createNight).toHaveBeenCalledTimes(1));
    // Typed on the Auckland wall clock: 22:00 and 06:00 NZST are 10:00Z and 18:00Z.
    expect(vi.mocked(createNight).mock.calls[0]).toEqual(["2026-08-18T10:00:00.000Z", "2026-08-18T18:00:00.000Z"]);
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("updates an existing night with its expected version, omitting wakeAt while it is still in progress", async () => {
    vi.mocked(updateNight).mockResolvedValue(undefined);
    render(
      <SleepNightSheet
        timezone={timezone}
        open
        plan={night({ status: "sleeping" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save night" }));
    await vi.waitFor(() => expect(updateNight).toHaveBeenCalledTimes(1));
    const [id, expectedVersion, sleepAt, wakeAt] = vi.mocked(updateNight).mock.calls[0]!;
    expect(id).toBe("night-one");
    expect(expectedVersion).toBe(3);
    expect(new Date(sleepAt).getTime()).toBe(new Date("2026-08-18T12:10:00.000Z").getTime());
    expect(wakeAt).toBeUndefined();
  });

  it("keeps the sheet open and shows the server's message when the save is rejected", async () => {
    vi.mocked(createNight).mockRejectedValue(new Error("Wake time must be after sleep time."));
    const onClose = vi.fn();
    render(<SleepNightSheet timezone={timezone} open plan={null} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save night" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Wake time must be after sleep time.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
