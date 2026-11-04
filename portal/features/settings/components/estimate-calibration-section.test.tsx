// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { EstimateCalibrationSection } from "@/features/settings/components/estimate-calibration-section";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("EstimateCalibrationSection", () => {
  it("says there is not enough history with the seed state", () => {
    render(<EstimateCalibrationSection />);
    expect(
      screen.getByText(/Not enough history yet\. Estimates start adjusting after 5 finished actions/)
    ).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("lists the overall factor and per-area factors by area name, skipping vanished areas", () => {
    context.state = {
      ...seed,
      estimateCalibration: {
        overall: { factor: 1.25, samples: 7, lastSampleAt: "2026-08-10T09:00:00.000Z" },
        areas: [
          { areaId: "area-study", factor: 1.4, samples: 5, lastSampleAt: "2026-08-09T09:00:00.000Z" },
          { areaId: "area-gone", factor: 0.9, samples: 6, lastSampleAt: "2026-08-08T09:00:00.000Z" }
        ]
      }
    };
    render(<EstimateCalibrationSection />);
    expect(screen.getByText(/^All areas: ×1.25 from 7 finished actions, last on .*2026/)).toBeTruthy();
    expect(screen.getByText(/^Study: ×1.40 from 5 finished actions, last on .*2026/)).toBeTruthy();
    expect(screen.queryByText(/area-gone/)).toBeNull();
    expect(screen.queryByText(/×0.90/)).toBeNull();
  });

  it("saves the toggle alone through save_entity on settings", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<EstimateCalibrationSection />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({ estimateCalibrationEnabled: false });
  });
});
