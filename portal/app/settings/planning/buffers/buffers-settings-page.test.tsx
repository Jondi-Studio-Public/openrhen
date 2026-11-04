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

describe("Buffers settings page", () => {
  it("saves only the buffer fields, not sleep or planning", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText("Default setup before (minutes)"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect(command.entity.defaultSetupBufferMinutes).toBe(25);
    expect(command.entity).not.toHaveProperty("preferredBedtime");
    expect(command.entity).not.toHaveProperty("timezone");
  });

  it("saves an edited arrival margin alongside the other buffers", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Arrival margin/), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entity.arrivalMarginMinutes).toBe(10);
  });

  it("refuses an arrival margin outside 0-60 minutes before saving", async () => {
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Arrival margin/), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Arrival margin");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("saves an edited start-by warning lead alongside the other buffers", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Start-by warning lead/), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entity.startByWarningMinutes).toBe(45);
  });

  it("sends an explicit null default mode when none is chosen, and the chosen mode otherwise", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: BuffersSettingsPage } = await import("./page");
    const { unmount } = render(<BuffersSettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand.mock.calls[0]![0].entity.defaultTransportMode).toBeNull();
    unmount();

    context.saveEntityCommand.mockClear();
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Default mode/), { target: { value: "car" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand.mock.calls[0]![0].entity.defaultTransportMode).toBe("car");
  });

  it("refuses a start-by warning lead outside 0-240 minutes before saving", async () => {
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Start-by warning lead/), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Start-by warning lead");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("saves an edited session break alongside the other buffers", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Break after a maximum session/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entity.sessionBreakMinutes).toBe(20);
  });

  it("refuses a session break outside 0-120 minutes before saving", async () => {
    const { default: BuffersSettingsPage } = await import("./page");
    render(<BuffersSettingsPage />);
    fireEvent.change(screen.getByLabelText(/^Break after a maximum session/), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save buffers" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Session break");
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });
});
