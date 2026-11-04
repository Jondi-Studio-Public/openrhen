// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

const location = (id: string, name: string): PortalState["conditionDefinitions"][number] => ({
  id,
  name,
  kind: "location",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: []
});

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("Conditions settings page", () => {
  it("saves the chosen home base immediately as a settings patch", async () => {
    context.state = {
      ...seed,
      conditionDefinitions: [location("home", "Home"), location("campus", "Campus")]
    } as PortalState;
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: ConditionsSettingsPage } = await import("./page");
    render(<ConditionsSettingsPage />);
    const picker = screen.getByLabelText(/^Home base/) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "campus" } });
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({ homeLocationId: "campus" });
  });
});
