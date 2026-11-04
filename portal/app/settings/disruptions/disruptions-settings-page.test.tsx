// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = { state: seed, ready: true, saving: false, saveEntityCommand: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  context.state = seed;
  context.ready = true;
  context.saveEntityCommand.mockReset();
});

describe("Disruption settings page", () => {
  it("opens with the default kind labels, when presets, and duration presets", async () => {
    const { default: DisruptionSettingsPage } = await import("./page");
    render(<DisruptionSettingsPage />);
    expect((screen.getByDisplayValue("Work") as HTMLInputElement).value).toBe("Work");
    expect((screen.getByDisplayValue("Life admin") as HTMLInputElement).value).toBe("Life admin");
    expect(screen.getAllByDisplayValue("Now").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("Rest of day").length).toBeGreaterThan(0);
  });

  it("saves an edited kind label as part of the whole preset payload", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    const { default: DisruptionSettingsPage } = await import("./page");
    render(<DisruptionSettingsPage />);
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Job" } });
    fireEvent.click(screen.getByRole("button", { name: "Save disruption presets" }));
    await act(async () => {});
    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [
      { entityType: string; entity: Record<string, unknown> }
    ];
    expect(command.entityType).toBe("settings");
    expect((command.entity.disruptionKindLabels as Record<string, string>).work).toBe("Job");
    expect(command.entity.disruptionWhenPresets).toBeTruthy();
    expect(command.entity.disruptionDurationPresets).toBeTruthy();
  });

  it("hides the minutes field once a duration preset's kind is switched away from Minutes", async () => {
    const { default: DisruptionSettingsPage } = await import("./page");
    render(<DisruptionSettingsPage />);
    expect(screen.getAllByLabelText("Minutes").length).toBeGreaterThan(0);
    const minutesCountBefore = screen.getAllByLabelText("Minutes").length;
    fireEvent.change(screen.getAllByLabelText("Kind")[0]!, { target: { value: "rest_of_day" } });
    expect(screen.getAllByLabelText("Minutes").length).toBe(minutesCountBefore - 1);
  });

  it("composes a null expectedVersion when any section was seeded before a version was known, even once the other three have reseeded live", async () => {
    context.saveEntityCommand.mockResolvedValue(undefined);
    // The real window: the provider seeds state (via `defaultPlanningSettings()`, which carries no
    // `version`) before the fetch resolves, and no settings page gates its form on `ready` — so the
    // page renders and is editable with `ready === false` and `settingsVersion === null`.
    context.state = seed;
    context.ready = false;
    const { default: DisruptionSettingsPage } = await import("./page");
    const view = render(<DisruptionSettingsPage />);

    // Dirty the kind-labels section while it is still pre-ready and its seeded version is null,
    // freezing it there — the hook stops reseeding once dirty, ready or not.
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Job" } });

    // The fetch resolves: `ready` flips true and a live version becomes known. The three untouched
    // sections reseed to it; the dirtied one does not.
    context.state = { ...seed, settings: { ...seed.settings, version: 7 } } as unknown as PortalState;
    context.ready = true;
    view.rerender(<DisruptionSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save disruption presets" }));
    await act(async () => {});

    expect(context.saveEntityCommand).toHaveBeenCalledTimes(1);
    const [command] = context.saveEntityCommand.mock.calls[0] as [{ expectedVersion: unknown }];
    expect(command.expectedVersion).toBeNull();
  });
});
