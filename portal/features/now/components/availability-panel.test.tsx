// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { AvailabilityPanel } from "./availability-panel";

const now = new Date("2026-08-18T10:00:00.000Z");

describe("AvailabilityPanel", () => {
  it("saves the reported energy without touching the reported contexts", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <AvailabilityPanel
        state={createSeedState(now)}
        saving={false}
        now={now}
        situationLocation={undefined}
        situationLocationTrusted={false}
        sleepDue={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: "High focus" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "save_entity",
        entityType: "current_availability",
        // Picking an energy is saying it, so the server dates it even when it is the stored value.
        entity: { currentEnergy: "high", assertedConditions: ["home", "laptop"], energyAsserted: true }
      })
    );
  });

  it("re-says the energy already selected when it is tapped again, so a stale one can be confirmed", () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const state = { ...createSeedState(now), currentEnergy: "low" as const };
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={undefined}
        situationLocationTrusted={false}
        sleepDue={false}
        saveEntityCommand={saveEntityCommand}
      />
    );
    const low = screen.getByRole("radio", { name: "Low focus" }) as HTMLInputElement;
    expect(low.checked).toBe(true);
    fireEvent.click(low);
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entity: expect.objectContaining({ currentEnergy: "low", energyAsserted: true }) })
    );
  });

  it("warns that sleep outranks the ranked work while sleep is due", () => {
    render(
      <AvailabilityPanel
        state={createSeedState(now)}
        saving={false}
        now={now}
        situationLocation={undefined}
        situationLocationTrusted={false}
        sleepDue
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByText(/an overdue sleep limit takes priority/)).toBeTruthy();
  });
});

const homeLocation = {
  id: "home",
  kind: "location",
  name: "Home",
  status: "active",
  portability: "fixed",
  pathways: []
} as unknown as ReturnType<typeof createSeedState>["conditionDefinitions"][number];

describe("AvailabilityPanel summary variant", () => {
  it("shows one line and opens the full panel in a sheet", () => {
    const location = { ...homeLocation };
    const state = { ...createSeedState(now), conditionDefinitions: [location] };
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={location}
        situationLocationTrusted
        sleepDue={false}
        saveEntityCommand={vi.fn()}
        variant="summary"
      />
    );
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`${state.currentEnergy} focus · at ${location.name}`) })
    );
    const dialog = screen.getByRole("dialog", { name: "Your situation" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("radio", { name: "High focus" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Available right now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Your situation" }));
    // The sheet now animates out rather than vanishing on the same tick — it stays mounted through
    // its exit transition, so the close only finishes once that transition ends.
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks a place that is no longer trusted on its chip, and leaves asking about it to Now's needs list", () => {
    const location = { ...homeLocation };
    const state = { ...createSeedState(now), conditionDefinitions: [location] };
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={location}
        situationLocationTrusted={false}
        sleepDue={false}
        saveEntityCommand={vi.fn()}
        variant="summary"
      />
    );
    expect(screen.getByText("Home?").getAttribute("data-unsure")).toBe("true");
    // "Still at Home" is one line of the needs list now, not a second prompt under the chips.
    expect(screen.queryByRole("button", { name: /still at/i })).toBeNull();
    expect(screen.queryByText(/nothing that follows from it is trusted/)).toBeNull();
  });
});

describe("AvailabilityPanel location suggestion prompt", () => {
  it("asks whether a differing place is where you are, and confirming asserts it the ordinary way", () => {
    const location = { ...homeLocation };
    const state = { ...createSeedState(now), conditionDefinitions: [location] };
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    const onDismissLocationPrompt = vi.fn();
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={location}
        situationLocationTrusted
        sleepDue={false}
        saveEntityCommand={saveEntityCommand}
        locationPrompt={{ locationId: "studio", locationName: "Studio" }}
        onConfirmLocationPrompt={() =>
          void saveEntityCommand({
            commandId: "prompt",
            expectedVersion: null,
            type: "save_entity",
            entityType: "current_availability",
            entity: { currentSituation: { locationId: "studio" } }
          })
        }
        onDismissLocationPrompt={onDismissLocationPrompt}
        variant="full"
      />
    );
    expect(screen.getByText("Looks like you're at Studio — confirm?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "current_availability",
        entity: expect.objectContaining({ currentSituation: { locationId: "studio" } })
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissLocationPrompt).toHaveBeenCalledTimes(1);
  });

  it("asks 'still at' rather than 'looks like' when the suggestion matches the held assertion", () => {
    const location = { ...homeLocation };
    const state = {
      ...createSeedState(now),
      conditionDefinitions: [location],
      currentSituation: { ...createSeedState(now).currentSituation, locationId: "home" }
    };
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={location}
        situationLocationTrusted={false}
        sleepDue={false}
        saveEntityCommand={vi.fn()}
        locationPrompt={{ locationId: "home", locationName: "Home" }}
        onConfirmLocationPrompt={vi.fn()}
        onDismissLocationPrompt={vi.fn()}
        variant="full"
      />
    );
    expect(screen.getByText("Still at Home?")).toBeTruthy();
  });

  it("shows the same prompt on the collapsed summary chip, before the sheet is opened", () => {
    const location = { ...homeLocation };
    const state = { ...createSeedState(now), conditionDefinitions: [location] };
    const onConfirmLocationPrompt = vi.fn();
    render(
      <AvailabilityPanel
        state={state}
        saving={false}
        now={now}
        situationLocation={location}
        situationLocationTrusted
        sleepDue={false}
        saveEntityCommand={vi.fn()}
        locationPrompt={{ locationId: "studio", locationName: "Studio" }}
        onConfirmLocationPrompt={onConfirmLocationPrompt}
        onDismissLocationPrompt={vi.fn()}
        variant="summary"
      />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirmLocationPrompt).toHaveBeenCalledTimes(1);
  });

  it("renders nothing extra when there is no prompt", () => {
    render(
      <AvailabilityPanel
        state={createSeedState(now)}
        saving={false}
        now={now}
        situationLocation={undefined}
        situationLocationTrusted={false}
        sleepDue={false}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
