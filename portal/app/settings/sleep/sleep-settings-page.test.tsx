// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { VERSION_CONFLICT_MESSAGE } from "@/shared/use-server-draft";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

let rerenderPage: () => void = () => {};

afterEach(() => {
  context.state = seed;
  context.saveEntityCommand.mockReset();
});

describe("Sleep settings page", () => {
  it("saves only the sleep fields it owns, not the whole settings object", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: SleepSettingsPage } = await import("./page");
    render(<SleepSettingsPage />);
    fireEvent.change(screen.getByLabelText("Preferred bedtime"), { target: { value: "23:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sleep settings" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity.preferredBedtime).toBe("23:15");
    expect(command.entity).not.toHaveProperty("timezone");
    expect(command.entity).not.toHaveProperty("defaultUsableFraction");
  });

  it("refuses a minimum sleep above the desired sleep before saving", async () => {
    context.state = {
      ...seed,
      settings: { ...seed.settings, desiredSleepMinutes: 480, minimumSleepMinutes: 600 }
    } as unknown as PortalState;
    const { default: SleepSettingsPage } = await import("./page");
    render(<SleepSettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Save sleep settings" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Minimum sleep");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("points at the routine builder rather than hosting its board", async () => {
    const { default: SleepSettingsPage } = await import("./page");
    render(<SleepSettingsPage />);
    expect(screen.getByRole("link", { name: "Open routine builder" }).getAttribute("href")).toBe("/settings/routines");
  });

  it("offers to reload or keep mine when the save conflicts with an edit made elsewhere", async () => {
    // Another device really changed a sleep field this page owns, so the conflict is genuine.
    context.saveEntityCommand
      .mockImplementationOnce(async () => {
        context.state = {
          ...seed,
          settings: { ...seed.settings, preferredBedtime: "21:30", version: (seed.settings.version ?? 0) + 1 }
        } as unknown as PortalState;
        rerenderPage();
        throw new Error(VERSION_CONFLICT_MESSAGE);
      })
      .mockResolvedValueOnce(undefined);
    const { default: SleepSettingsPage } = await import("./page");
    const { rerender } = render(<SleepSettingsPage />);
    rerenderPage = () => rerender(<SleepSettingsPage />);
    fireEvent.change(screen.getByLabelText("Preferred bedtime"), { target: { value: "23:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sleep settings" }));
    // The rejected save settles on a later tick; waiting a fixed 5ms lost that race on a loaded CI runner.
    expect(await screen.findByText("These settings changed on another device.")).toBeTruthy();
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await act(async () => {});

    expect(context.saveEntityCommand).toHaveBeenCalledTimes(2);
    const [secondCommand] = context.saveEntityCommand.mock.calls[1] as [{ expectedVersion: unknown }];
    expect(secondCommand.expectedVersion).toBe(context.state.settings.version ?? null);
    expect(screen.queryByText("These settings changed on another device.")).toBeNull();
  });

  it("retries silently when only the wake time or situation moved the shared version", async () => {
    const baseVersion = seed.settings.version ?? 0;
    context.state = {
      ...seed,
      settings: { ...seed.settings, lastWokeAt: "2026-08-18T06:00:00.000Z" }
    } as unknown as PortalState;
    context.saveEntityCommand
      .mockImplementationOnce(async () => {
        // "I'm awake" pressed meanwhile: newer version and wake time, every sleep field untouched.
        context.state = {
          ...seed,
          settings: { ...seed.settings, lastWokeAt: "2026-08-19T06:00:00.000Z", version: baseVersion + 1 }
        } as unknown as PortalState;
        rerenderPage();
        throw new Error(VERSION_CONFLICT_MESSAGE);
      })
      .mockResolvedValueOnce(undefined);
    const { default: SleepSettingsPage } = await import("./page");
    const { rerender } = render(<SleepSettingsPage />);
    rerenderPage = () => rerender(<SleepSettingsPage />);
    fireEvent.change(screen.getByLabelText("Preferred bedtime"), { target: { value: "23:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sleep settings" }));
    await waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("These settings changed on another device.")).toBeNull();
    const [retry] = context.saveEntityCommand.mock.calls[1] as [
      { expectedVersion: unknown; entity: Record<string, unknown> }
    ];
    expect(retry.expectedVersion).toBe(baseVersion + 1);
    expect(retry.entity.preferredBedtime).toBe("23:15");
    expect(retry.entity).not.toHaveProperty("lastWokeAt");
  });
});
