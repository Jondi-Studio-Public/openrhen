// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { RecoveryWindowLine } from "./recovery-window-line";

const timezone = "Australia/Sydney";
// Monday 2026-09-07, 16:00 in the seed zone (UTC+10).
const before = new Date("2026-09-07T06:00:00.000Z");
const after = new Date("2026-09-07T09:30:00.000Z");

function stateWith(patch: Record<string, unknown> = {}, dailyPlan?: Record<string, unknown>) {
  const seed = createSeedState(before);
  return {
    ...seed,
    settings: { ...seed.settings, timezone, recoveryStartTime: "18:00", recoveryEndTime: "19:00", ...patch },
    ...(dailyPlan ? { dailyPlan } : {})
  } as ReturnType<typeof createSeedState>;
}

const plan = {
  id: "p",
  version: 3,
  localDate: "2026-09-07",
  desiredActionIds: ["a1"],
  deferredItems: [],
  recoverySkipped: false
};

describe("RecoveryWindowLine", () => {
  it("renders nothing when recovery is off, on another weekday, or after the window", () => {
    const save = vi.fn();
    const props = { timezone, saving: false, saveEntityCommand: save };
    const off = render(
      <RecoveryWindowLine
        {...props}
        state={stateWith({ recoveryStartTime: null, recoveryEndTime: null })}
        now={before}
      />
    );
    expect(off.container.textContent).toBe("");
    off.unmount();
    const otherDay = render(
      <RecoveryWindowLine {...props} state={stateWith({ recoveryWeekdays: [2, 3] })} now={before} />
    );
    expect(otherDay.container.textContent).toBe("");
    otherDay.unmount();
    const over = render(<RecoveryWindowLine {...props} state={stateWith()} now={after} />);
    expect(over.container.textContent).toBe("");
  });

  it("shows the window and skips today, carrying the plan's other fields", () => {
    const save = vi.fn();
    render(
      <RecoveryWindowLine
        state={stateWith({}, plan)}
        now={before}
        timezone={timezone}
        saving={false}
        saveEntityCommand={save}
      />
    );
    expect(screen.getByText(/Recovery 18:00–19:00 today/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip today" }));
    const [command] = save.mock.calls[0] as [
      { expectedVersion: number; entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("daily_plan");
    expect(command.expectedVersion).toBe(3);
    expect(command.entity).toMatchObject({
      localDate: "2026-09-07",
      desiredActionIds: ["a1"],
      deferredItems: [],
      recoverySkipped: true
    });
  });

  it("never writes the state's horizon override back, which may be carried over from another day's row", () => {
    const save = vi.fn();
    render(
      <RecoveryWindowLine
        state={stateWith({}, { ...plan, horizonOverrideAt: "2026-09-07T16:00:00.000Z" })}
        now={before}
        timezone={timezone}
        saving={false}
        saveEntityCommand={save}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip today" }));
    const [command] = save.mock.calls[0] as [{ entity: Record<string, unknown> }];
    expect("horizonOverrideAt" in command.entity).toBe(false);
  });

  it("offers Undo once skipped", () => {
    const save = vi.fn();
    render(
      <RecoveryWindowLine
        state={stateWith({}, { ...plan, recoverySkipped: true })}
        now={before}
        timezone={timezone}
        saving={false}
        saveEntityCommand={save}
      />
    );
    expect(screen.getByText(/Recovery skipped today/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((save.mock.calls[0]![0] as { entity: Record<string, unknown> }).entity.recoverySkipped).toBe(false);
  });

  it("a skip saved for yesterday does not count as today's", () => {
    render(
      <RecoveryWindowLine
        state={stateWith({}, { ...plan, localDate: "2026-09-06", recoverySkipped: true })}
        now={before}
        timezone={timezone}
        saving={false}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Skip today" })).toBeTruthy();
  });
  describe("overnight window", () => {
    // Friday 2026-09-04 and Saturday 2026-09-05 in the seed zone (UTC+10); Friday-only 23:00 to 06:00.
    const overnight = { recoveryStartTime: "23:00", recoveryEndTime: "06:00", recoveryWeekdays: [5] };
    const friday2300 = new Date("2026-09-04T13:00:00.000Z");
    const saturday0500 = new Date("2026-09-04T19:00:00.000Z");
    const saturday0600 = new Date("2026-09-04T20:00:00.000Z");
    const props = { timezone, saving: false };

    it("keeps the control at 23:00 and saves against that day", () => {
      const save = vi.fn();
      render(
        <RecoveryWindowLine
          {...props}
          state={stateWith(overnight, { ...plan, localDate: "2026-09-04" })}
          now={friday2300}
          saveEntityCommand={save}
        />
      );
      expect(screen.getByText(/Recovery 23:00–06:00 today/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Skip today" }));
      expect((save.mock.calls[0] as [{ entity: Record<string, unknown> }])[0].entity.localDate).toBe("2026-09-04");
    });

    it("at 05:00 Saturday skips Friday's occurrence, flag only", () => {
      const save = vi.fn();
      render(
        <RecoveryWindowLine
          {...props}
          state={stateWith(overnight, { ...plan, localDate: "2026-09-05" })}
          now={saturday0500}
          saveEntityCommand={save}
        />
      );
      expect(screen.getByText(/Recovery 23:00–06:00 last night/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      const [command] = save.mock.calls[0] as [{ expectedVersion: unknown; entity: Record<string, unknown> }];
      expect(command.expectedVersion).toBeNull();
      expect(command.entity).toEqual({ localDate: "2026-09-04", recoverySkipped: true, recoverySkippedOnly: true });
    });

    it("reads a skipped Friday occurrence from the skipped dates and offers Undo", () => {
      render(
        <RecoveryWindowLine
          {...props}
          state={stateWith(overnight, { ...plan, localDate: "2026-09-05", recoverySkippedDates: ["2026-09-04"] })}
          now={saturday0500}
          saveEntityCommand={vi.fn()}
        />
      );
      expect(screen.getByText(/Recovery skipped last night/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    });

    it("hides the control once the window has ended", () => {
      const { container } = render(
        <RecoveryWindowLine {...props} state={stateWith(overnight)} now={saturday0600} saveEntityCommand={vi.fn()} />
      );
      expect(container.textContent).toBe("");
    });
  });
});
