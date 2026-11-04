// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { calendarSinkConnection, primarySourceLabel, registerConnectionManifest } from "@openrhen/contracts";

// A calendar sink with a publish window, so the page has one to describe even in a build that registers none; where a
// real sink is already registered it is the one the page reads.
registerConnectionManifest({
  id: "example_sink",
  label: "Example Sink",
  capabilities: ["calendar_sink"],
  ops: {},
  secrets: { anyOf: [["EXAMPLE_SINK_TOKEN"]] },
  config: { EXAMPLE_SINK_PUBLISH_WINDOW_DAYS: { required: false, default: "60" } }
});
const sharedShifts = new RegExp(`Share imported ${primarySourceLabel()} events`);

const seed = createSeedState(new Date("2026-09-09T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("Family calendar settings page", () => {
  it("saves both toggle fields when changed", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: FamilyCalendarSettingsPage } = await import("./page");
    render(<FamilyCalendarSettingsPage />);

    const masterSwitch = screen.getByRole("checkbox", { name: /Share chosen commitments/ });
    const shiftsToggle = screen.getByRole("checkbox", { name: sharedShifts });

    fireEvent.click(masterSwitch);
    fireEvent.click(shiftsToggle);
    fireEvent.click(screen.getByRole("button", { name: "Save family calendar settings" }));

    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity).toEqual({
      calendarShareEnabled: true,
      sharePrimaryEvents: true
    });
  });

  it("persists toggled state and reloads from server on conflict", async () => {
    context.state = {
      ...seed,
      settings: {
        ...seed.settings,
        calendarShareEnabled: true,
        sharePrimaryEvents: false,
        version: seed.settings.version
      }
    };
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: FamilyCalendarSettingsPage } = await import("./page");
    render(<FamilyCalendarSettingsPage />);

    const masterSwitch = screen.getByRole("checkbox", { name: /Share chosen commitments/ }) as HTMLInputElement;
    const shiftsToggle = screen.getByRole("checkbox", { name: sharedShifts }) as HTMLInputElement;

    expect(masterSwitch.checked).toBe(true);
    expect(shiftsToggle.checked).toBe(false);

    fireEvent.click(shiftsToggle);
    expect(shiftsToggle.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save family calendar settings" }));

    await act(async () => {});
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ entity: Record<string, unknown> }];
    expect(command.entity.sharePrimaryEvents).toBe(true);
  });

  it("displays read-only window configuration information", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: FamilyCalendarSettingsPage } = await import("./page");
    render(<FamilyCalendarSettingsPage />);

    const windowInfo = screen.getByText(/Configured via deployment/);
    expect(windowInfo).not.toBeNull();
    expect(windowInfo.textContent).toContain(
      Object.keys(calendarSinkConnection()!.config).find((name) => name.endsWith("PUBLISH_WINDOW_DAYS"))
    );
  });
});
