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

describe("Energy meanings settings page", () => {
  it("saves the whole energyMeanings object alone", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: EnergyMeaningsSettingsPage } = await import("./page");
    render(<EnergyMeaningsSettingsPage />);
    fireEvent.change(screen.getByDisplayValue("Deep focus"), { target: { value: "Sharp focus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save energy meanings" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({
      energyMeanings: { ...seed.settings.energyMeanings, high: "Sharp focus" }
    });
  });
});
