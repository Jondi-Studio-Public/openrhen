// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("Estimate buckets settings page", () => {
  it("saves the parsed bucket list alone", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: EstimateBucketsSettingsPage } = await import("./page");
    render(<EstimateBucketsSettingsPage />);
    fireEvent.change(screen.getByLabelText(/Minutes, smallest to largest/), {
      target: { value: "10, 20, 45, 90" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save estimate buckets" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({ estimateBucketsMinutes: [10, 20, 45, 90] });
  });

  it("refuses buckets out of ascending order before saving", async () => {
    const { default: EstimateBucketsSettingsPage } = await import("./page");
    render(<EstimateBucketsSettingsPage />);
    fireEvent.change(screen.getByLabelText(/Minutes, smallest to largest/), { target: { value: "30, 10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save estimate buckets" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("ascending order");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });
});
