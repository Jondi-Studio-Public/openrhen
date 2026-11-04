// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const baseState = { ...seed, settings: { ...seed.settings, version: 1 } };
const context: {
  state: typeof baseState;
  ready: boolean;
  saving: boolean;
  saveEntityCommand: ReturnType<typeof vi.fn>;
  addCapture: ReturnType<typeof vi.fn>;
} = { state: baseState, ready: true, saving: false, saveEntityCommand: vi.fn(), addCapture: vi.fn() };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

afterEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    // No storage in this environment.
  }
  context.state = baseState;
  context.saveEntityCommand.mockReset();
  context.addCapture.mockReset();
  context.saving = false;
});

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
/** Fills step 1, then moves through to the last step. */
function toLastStep(wake = "2026-08-18T07:00") {
  fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: wake } });
  press("Continue");
  press("Continue");
}

describe("Setup page", () => {
  it("rejects a save composed from a version that changed underneath it, instead of re-reading the live version at submit", async () => {
    const { default: SetupPage } = await import("./page");
    const { rerender } = render(<SetupPage />);

    // Required field for validation.
    fireEvent.change(screen.getByLabelText("When did you last wake?"), {
      target: { value: "2026-08-18T07:00" }
    });

    // Mark the draft dirty at version 1, before the stored version moves.
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });

    // A concurrent edit lands elsewhere: the stored settings version advances underneath this
    // still-open form.
    context.state = { ...context.state, settings: { ...context.state.settings, version: 2 } };
    rerender(<SetupPage />);

    // Stand in for the server's real optimistic-concurrency check (`verifyVersion` in
    // entity-commands.ts): only the record's true current version (2) is accepted.
    context.saveEntityCommand.mockImplementation((command: { expectedVersion: number | null }) =>
      command.expectedVersion === 2
        ? Promise.resolve()
        : Promise.reject(new Error("This record changed elsewhere. Reload before saving."))
    );

    press("Continue");
    press("Continue");
    press("Finish setup");
    await act(async () => {});

    expect(await screen.findByText("This record changed elsewhere. Reload before saving.")).toBeTruthy();
    // The save was rejected: the setup form is still showing, not the "setup complete" state.
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeTruthy();
  });

  it("walks three steps with a counter, one Continue on each, Skip for now after the first, and the sleep sentence live", async () => {
    const { default: SetupPage } = await import("./page");
    context.state = {
      ...context.state,
      settings: { ...context.state.settings, preferredBedtime: "22:40", preferredWakeTime: "06:20" }
    };
    render(<SetupPage />);
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("When do you sleep?");
    expect(screen.getByText(/OpenRhen plans around your sleep first, so nothing lands at 2 am\./)).toBeTruthy();
    expect(screen.getByText(/That's 7 h 40 m a night\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Usually up at"), { target: { value: "07:00" } });
    expect(screen.getByText(/That's 8 h 20 m a night\./)).toBeTruthy();
    expect(screen.queryByText("Confirm setup")).toBeNull();
    // Step 1 holds the last wake, which setup always saved, so it cannot be skipped past.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    // With no navigation on setup, step 1 still offers a way out, which saves nothing.
    expect(screen.getByRole("link", { name: "Back to Now" }).getAttribute("href")).toBe("/");
    // Step 1 needs the last wake before moving on.
    press("Continue");
    expect(screen.getByText("Add when you last woke.")).toBeTruthy();
    expect(screen.getByLabelText("When did you last wake?").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("When did you last wake?"));
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    press("Continue");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to Now" })).toBeNull();
    press("Skip for now");
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
  });

  it("refuses a timezone that is not a real zone on step 1, beside the field, and saves nothing", async () => {
    const { default: SetupPage } = await import("./page");
    render(<SetupPage />);
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Mars/Olympus" } });
    press("Continue");
    expect(screen.getByText(/Pick a timezone from the list, for example America\/New_York\./)).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByLabelText("Timezone").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Timezone"));
    expect(context.saveEntityCommand).not.toHaveBeenCalled();
    // UTC and an alias a datalist would not list are still real zones.
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Etc/GMT+10" } });
    press("Continue");
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("offers the zones as a pick list and shows the time it is in the chosen zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T20:30:00.000Z"));
    try {
      const { default: SetupPage } = await import("./page");
      render(<SetupPage />);
      expect(screen.getByLabelText("Timezone").getAttribute("list")).toBeTruthy();
      typeZone("Australia/Sydney");
      expect(screen.getByText(/It is 6:30 am where you are/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("jumps back to step 1 when Finish is refused for the zone, without the server's API wording", async () => {
    const { default: SetupPage } = await import("./page");
    context.saveEntityCommand.mockRejectedValue(
      new Error(
        'Timezone "X/Y" is not valid: it must be a valid IANA time zone. Repeat the same call with the corrected value.'
      )
    );
    render(<SetupPage />);
    toLastStep();
    press("Finish setup");
    await act(async () => {});
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByText(/Repeat the same call/)).toBeNull();
    expect(screen.getByText(/Pick a timezone from the list/)).toBeTruthy();
  });

  it("keeps the answers across a reload, Back keeps them too, and finishing clears them", async () => {
    const { default: SetupPage } = await import("./page");
    context.saveEntityCommand.mockResolvedValue(undefined);
    const first = render(<SetupPage />);
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    typeZone("Europe/Paris");
    press("Continue");
    press("Continue");
    fireEvent.change(screen.getByLabelText("The first thing to plan"), { target: { value: "Renew passport" } });
    first.unmount();
    render(<SetupPage />);
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect((screen.getByLabelText("The first thing to plan") as HTMLTextAreaElement).value).toBe("Renew passport");
    press("Back");
    press("Back");
    expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("Europe/Paris");
    expect((screen.getByLabelText("When did you last wake?") as HTMLInputElement).value).toBe("2026-08-18T07:00");
    press("Continue");
    press("Continue");
    press("Finish setup");
    await act(async () => {});
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not move focus to the heading when a reload restores step 3, but does when the person moves", async () => {
    const { default: SetupPage } = await import("./page");
    window.sessionStorage.setItem(
      "openrhen-setup-draft",
      JSON.stringify({ v: 1, step: 3, lastWake: "2026-08-18T07:00", firstThing: "", placeId: "", draft: {} })
    );
    render(<SetupPage />);
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    press("Back");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("shows an unrelated server error as it is, even when it mentions the word timezone", async () => {
    const { default: SetupPage } = await import("./page");
    context.saveEntityCommand.mockRejectedValue(new Error("The timezone database is unavailable."));
    render(<SetupPage />);
    toLastStep();
    press("Finish setup");
    await act(async () => {});
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(screen.getByText("The timezone database is unavailable.")).toBeTruthy();
  });

  it("does not restore a stored draft once setup is complete, and drops it", async () => {
    const { default: SetupPage } = await import("./page");
    window.sessionStorage.setItem(
      "openrhen-setup-draft",
      JSON.stringify({ v: 1, step: 3, lastWake: "2026-08-18T07:00", firstThing: "old", placeId: "", draft: {} })
    );
    context.state = {
      ...context.state,
      settings: { ...context.state.settings, setupCompletedAt: "2026-08-18T09:00:00.000Z" }
    };
    render(<SetupPage />);
    expect(window.sessionStorage.getItem("openrhen-setup-draft")).toBeNull();
  });

  it("ignores a stored draft it cannot read, and a step past 1 with no last wake", async () => {
    const { default: SetupPage } = await import("./page");
    window.sessionStorage.setItem("openrhen-setup-draft", "{not json");
    const { unmount } = render(<SetupPage />);
    expect(screen.getByText("1 of 3")).toBeTruthy();
    unmount();
    window.sessionStorage.setItem(
      "openrhen-setup-draft",
      JSON.stringify({ v: 1, step: 3, lastWake: "", firstThing: "", placeId: "", draft: {} })
    );
    render(<SetupPage />);
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it("fills the last wake with now in the form's zone from a button", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T20:30:00.000Z"));
    try {
      const { default: SetupPage } = await import("./page");
      render(<SetupPage />);
      typeZone("Australia/Sydney");
      press("I woke just now");
      expect((screen.getByLabelText("When did you last wake?") as HTMLInputElement).value).toBe("2026-08-19T06:30");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks progress for assistive tech and titles each step", async () => {
    const { default: SetupPage } = await import("./page");
    render(<SetupPage />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
    expect(document.title).toBe("Setup 1 of 3 - OpenRhen");
  });

  it("lists what setup did on the done screen, and what is still missing", async () => {
    const { default: SetupPage } = await import("./page");
    context.state = {
      ...context.state,
      conditionDefinitions: [],
      settings: { ...context.state.settings, setupCompletedAt: "2026-08-18T09:00:00.000Z" }
    };
    render(<SetupPage />);
    expect(screen.queryByText("Your planning foundation is ready.")).toBeNull();
    expect(screen.getByText(/You have not added a place yet/)).toBeTruthy();
    expect(screen.getByText(/seven starter areas/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add your home" }).getAttribute("href")).toBe(
      "/settings/catalogues/conditions"
    );
  });

  const typeZone = (zone: string) => fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: zone } });

  it("limits the last wake to now in the timezone on the form, not the browser's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T20:30:00.000Z"));
    try {
      const { default: SetupPage } = await import("./page");
      render(<SetupPage />);
      typeZone("Australia/Sydney");
      expect(screen.getByLabelText("When did you last wake?").getAttribute("max")).toBe("2026-08-19T06:30");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the last wake in the timezone on the form when saving", async () => {
    const { default: SetupPage } = await import("./page");
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<SetupPage />);
    typeZone("Australia/Sydney");
    toLastStep("2026-01-10T07:00");
    press("Finish setup");
    await act(async () => {});
    expect(context.saveEntityCommand.mock.calls[0]![0].entity.lastWokeAt).toBe("2026-01-09T20:00:00.000Z");
  });

  it("starts a first run from the browser's zone and English date format, and saves them", async () => {
    const { default: SetupPage } = await import("./page");
    const zone = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "Europe/London" } as Intl.ResolvedDateTimeFormatOptions);
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
    try {
      context.state = { ...context.state, settings: { ...context.state.settings, timezone: "UTC" } };
      context.saveEntityCommand.mockResolvedValue(undefined);
      render(<SetupPage />);
      expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("Europe/London");
      toLastStep();
      press("Finish setup");
      await act(async () => {});
      const entity = context.saveEntityCommand.mock.calls[0]![0].entity;
      expect(entity.timezone).toBe("Europe/London");
      expect(entity.locale).toBe("en-GB");
    } finally {
      zone.mockRestore();
      language.mockRestore();
    }
  });

  it("says why Finish is disabled while the plan is updating", async () => {
    const { default: SetupPage } = await import("./page");
    context.saving = true;
    render(<SetupPage />);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Waiting for the plan to finish updating…")).toBeTruthy();
  });

  it("captures the first thing to plan after the settings, and Skip for now on the last step saves without it", async () => {
    const { default: SetupPage } = await import("./page");
    context.saveEntityCommand.mockResolvedValue(undefined);
    context.addCapture.mockResolvedValue(undefined);
    const { unmount } = render(<SetupPage />);
    toLastStep();
    fireEvent.change(screen.getByLabelText("The first thing to plan"), { target: { value: " Renew passport " } });
    press("Finish setup");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(context.saveEntityCommand.mock.calls[0]![0].entity.setupCompleted).toBe(true);
    expect(context.addCapture).toHaveBeenCalledWith("Renew passport");
    unmount();
    context.saveEntityCommand.mockClear();
    context.addCapture.mockClear();
    render(<SetupPage />);
    toLastStep();
    fireEvent.change(screen.getByLabelText("The first thing to plan"), { target: { value: "Renew passport" } });
    press("Skip for now");
    await act(async () => {});
    expect(context.saveEntityCommand.mock.calls[0]![0].entity.setupCompleted).toBe(true);
    expect(context.addCapture).not.toHaveBeenCalled();
  });

  it("names the page Setup once done", async () => {
    const { default: SetupPage } = await import("./page");
    const { rerender } = render(<SetupPage />);

    context.state = {
      ...context.state,
      settings: { ...context.state.settings, setupCompletedAt: "2026-08-18T09:00:00.000Z" }
    };
    rerender(<SetupPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Setup");
    expect(screen.getByText(/Your sleep, timezone and last wake are saved/)).toBeTruthy();
  });

  it("saves the place picked from Conditions as the current location, after the settings", async () => {
    const { default: SetupPage } = await import("./page");
    const home = {
      ...context.state.conditionDefinitions[0]!,
      id: "ctx-home",
      name: "Home",
      kind: "location" as const,
      status: "active" as const
    };
    context.state = {
      ...context.state,
      conditionDefinitions: [home],
      currentSituation: { ...context.state.currentSituation, locationId: null }
    };
    context.saveEntityCommand.mockResolvedValue(undefined);
    render(<SetupPage />);
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    press("Continue");
    fireEvent.change(screen.getByLabelText("Where are you right now?"), { target: { value: "ctx-home" } });
    press("Continue");
    press("Finish setup");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const commands = context.saveEntityCommand.mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.entityType)).toEqual(["settings", "current_availability"]);
    expect(commands[0].entity).not.toHaveProperty("assertedConditions");
    expect(commands[1].entity.currentSituation).toEqual({ locationId: "ctx-home" });
  });

  it("retries the place once on a version conflict, and says setup saved when the place still fails", async () => {
    const { default: SetupPage } = await import("./page");
    const home = {
      ...context.state.conditionDefinitions[0]!,
      id: "ctx-home",
      name: "Home",
      kind: "location" as const,
      status: "active" as const
    };
    context.state = { ...context.state, conditionDefinitions: [home] };
    context.saveEntityCommand.mockImplementation((command: { entityType: string }) =>
      command.entityType === "settings"
        ? Promise.resolve()
        : Promise.reject(new Error("This record changed elsewhere. Reload before saving."))
    );
    const { rerender } = render(<SetupPage />);
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    press("Continue");
    fireEvent.change(screen.getByLabelText("Where are you right now?"), { target: { value: "ctx-home" } });
    press("Continue");
    press("Finish setup");
    // The save, its rejection and the one retry are three chained promises; wait for the retry, not a fixed sleep.
    await act(async () => {
      await vi.waitFor(() =>
        expect(context.saveEntityCommand.mock.calls.map(([command]) => command.entityType)).toEqual([
          "settings",
          "current_availability",
          "current_availability"
        ])
      );
    });
    context.state = {
      ...context.state,
      settings: { ...context.state.settings, setupCompletedAt: "2026-08-18T09:00:00.000Z" }
    };
    rerender(<SetupPage />);
    expect(screen.getByRole("alert").textContent).toBe("Setup saved, but where you are was not. Set it from Now.");
  });

  it("asks nothing about place when there are no places yet, and points to Places and energy once done", async () => {
    const { default: SetupPage } = await import("./page");
    context.state = { ...context.state, conditionDefinitions: [] };
    const { rerender } = render(<SetupPage />);
    fireEvent.change(screen.getByLabelText("When did you last wake?"), { target: { value: "2026-08-18T07:00" } });
    press("Continue");
    expect(screen.queryByLabelText("Where are you right now?")).toBeNull();
    context.state = {
      ...context.state,
      settings: { ...context.state.settings, setupCompletedAt: "2026-08-18T09:00:00.000Z" }
    };
    rerender(<SetupPage />);
    expect(screen.getByRole("link", { name: "Add your home" }).getAttribute("href")).toBe(
      "/settings/catalogues/conditions"
    );
    expect(screen.getByRole("link", { name: "Go to Now" }).getAttribute("href")).toBe("/");
  });
});

describe("browserSetupDefaults", () => {
  it("takes a valid zone and an English format the app offers", async () => {
    const { browserSetupDefaults } = await import("./page");
    expect(browserSetupDefaults("Australia/Perth", "en-AU")).toEqual({ timezone: "Australia/Perth", locale: "en-AU" });
    expect(browserSetupDefaults("UTC", "en")).toEqual({ timezone: "UTC", locale: "en" });
    expect(browserSetupDefaults("UTC", "en", "UTC")).toEqual({ timezone: "UTC", locale: "en" });
  });

  it("does not let a browser reporting UTC override a server zone that is not UTC", async () => {
    const { browserSetupDefaults } = await import("./page");
    expect(browserSetupDefaults("UTC", "en", "America/New_York")).toEqual({ locale: "en" });
    expect(browserSetupDefaults("Etc/UTC", undefined, "America/New_York")).toEqual({});
    expect(browserSetupDefaults("Europe/London", undefined, "America/New_York")).toEqual({ timezone: "Europe/London" });
  });

  it("ignores a zone or language it cannot use", async () => {
    const { browserSetupDefaults } = await import("./page");
    expect(browserSetupDefaults("Not/AZone", "fr-FR")).toEqual({});
    expect(browserSetupDefaults(undefined, "en-ZA")).toEqual({});
    expect(browserSetupDefaults("Europe/Paris", undefined)).toEqual({ timezone: "Europe/Paris" });
  });
});
