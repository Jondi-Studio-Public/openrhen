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

describe("Planning settings page", () => {
  it("saves timezone and the new planning horizon end field, not sleep or buffers", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: PlanningSettingsPage } = await import("./page");
    render(<PlanningSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Planning horizon end/), { target: { value: "21:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save planning settings" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity.planningHorizonEnd).toBe("21:30");
    expect(command.entity.timezone).toBe(seed.settings.timezone);
    expect(command.entity).not.toHaveProperty("preferredBedtime");
    expect(command.entity).not.toHaveProperty("defaultSetupBufferMinutes");
  });

  it("refuses an invalid timezone before saving", async () => {
    const { default: PlanningSettingsPage } = await import("./page");
    render(<PlanningSettingsPage />);
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Not/A/Zone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save planning settings" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("valid IANA timezone");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("saves the chosen date format", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: PlanningSettingsPage } = await import("./page");
    render(<PlanningSettingsPage />);
    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "en-US" } });
    fireEvent.click(screen.getByRole("button", { name: "Save planning settings" }));
    await act(async () => {});
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ entity: Record<string, unknown> }];
    expect(command.entity.locale).toBe("en-US");
  });
});

describe("timeZoneOptions", () => {
  it("lists every zone the browser knows with the stored one first, and always UTC", async () => {
    const { timeZoneOptions } = await import("./page");
    const options = timeZoneOptions("Pacific/Auckland");
    expect(options[0]).toBe("Pacific/Auckland");
    expect(options.filter((zone) => zone === "Pacific/Auckland")).toHaveLength(1);
    expect(options).toContain("Europe/London");
    expect(options).toContain("UTC");
  });

  it("keeps a stored zone the browser does not list", async () => {
    const { timeZoneOptions } = await import("./page");
    expect(timeZoneOptions("Etc/GMT+10").slice(0, 1)).toEqual(["Etc/GMT+10"]);
  });
});
