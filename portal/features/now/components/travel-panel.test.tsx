// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { TravelDirective } from "@/features/now/now-model";
import { TravelPanel } from "./travel-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const base = createSeedState(now);

const place = (id: string, name: string, coordinates: boolean) => ({
  id,
  name,
  kind: "location" as const,
  status: "active" as const,
  pathways: [],
  portability: "fixed" as const,
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: [],
  ...(coordinates ? { latitude: -33.8, longitude: 151.2 } : {})
});

const home = place("ctx-home", "Home", true);
const campus = place("ctx-campus", "Campus", true);

const state: PortalState = {
  ...base,
  conditionDefinitions: [home, campus],
  settings: { ...base.settings, homeLocationId: "ctx-home" },
  currentSituation: {
    ...base.currentSituation,
    locationId: "ctx-home",
    transportModes: ["car"]
  }
};

const directive: TravelDirective = {
  kind: "travel",
  toLocationId: "ctx-campus",
  title: "Drive to Campus",
  recommendedMinutes: 18,
  mode: "car",
  source: "fallback",
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
  then: { kind: "action", targetId: "a1", title: "Assessment 2", recommendedMinutes: 90 }
};

const props = {
  directive,
  destination: campus,
  state,
  saving: false,
  explanation: "Nothing at home outranks the work waiting at Campus.",
  evidence: ["Assessment 2 needs 90 minutes; 120 remain at Campus"],
  saveEntityCommand: vi.fn().mockResolvedValue(undefined)
};

afterEach(() => vi.unstubAllGlobals());

describe("TravelPanel", () => {
  it("states the leg, what waits at the other end, and how well the length is known", () => {
    render(<TravelPanel {...props} />);
    expect(screen.getByText("Drive to Campus · 18 min")).toBeTruthy();
    expect(screen.getByText("then Assessment 2 (90 min)")).toBeTruthy();
    expect(screen.getByText(/By car · the place's usual time/)).toBeTruthy();
    expect(screen.getByText("Why go now")).toBeTruthy();
    // A journey is exclusive: there is nothing to start against it.
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("shows the leave-by time and the usually/allowing split when the engine gives both", () => {
    render(
      <TravelPanel
        {...props}
        directive={{ ...directive, leaveBy: "2026-08-18T08:10:00.000Z", typicalMinutes: 22, recommendedMinutes: 28 }}
      />
    );
    expect(screen.getByText(/Leave by .* — usually 22 min, allowing 28/)).toBeTruthy();
  });

  it("names the sample count on the own-trips tier", () => {
    render(<TravelPanel {...props} directive={{ ...directive, source: "own", sampleCount: 4 }} />);
    expect(screen.getByText(/from your trips \(4\)/)).toBeTruthy();
  });

  it("arrives by asserting the location, which is the whole of completing a journey", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<TravelPanel {...props} saveEntityCommand={save} />);
    fireEvent.click(screen.getByRole("button", { name: "I’m at Campus" }));
    const command = save.mock.calls[0]![0];
    expect(command.entityType).toBe("current_availability");
    expect(command.entity.currentSituation).toEqual({ locationId: "ctx-campus" });
  });

  it("names a destination the plan knows but the contexts no longer define", () => {
    render(<TravelPanel {...props} destination={undefined} />);
    expect(screen.getByRole("button", { name: "I’m at ctx-campus" })).toBeTruthy();
  });

  it("offers to measure the leg only when the figure is not already known and a lookup is possible", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        estimate: { locationId: "ctx-campus", minutes: 21, mode: "car" },
        unroutable: false,
        remaining: 99
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<TravelPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Measure travel" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/travel/refresh");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ toLocationId: "ctx-campus" });
    unmount();

    // Already live: there is nothing to learn, and the lookup is scarce.
    render(<TravelPanel {...props} directive={{ ...directive, source: "live" }} />);
    expect(screen.queryByRole("button", { name: "Measure travel" })).toBeNull();
  });

  it("does not offer a measurement it cannot make", () => {
    const noModes: PortalState = {
      ...state,
      currentSituation: { ...state.currentSituation, transportModes: [] }
    };
    const { unmount } = render(<TravelPanel {...props} state={noModes} />);
    expect(screen.queryByRole("button", { name: "Measure travel" })).toBeNull();
    unmount();
    const noCoordinates: PortalState = {
      ...state,
      conditionDefinitions: [home, place("ctx-campus", "Campus", false)]
    };
    render(<TravelPanel {...props} state={noCoordinates} destination={place("ctx-campus", "Campus", false)} />);
    expect(screen.queryByRole("button", { name: "Measure travel" })).toBeNull();
  });

  it("does not offer to measure a leg from an assumed origin", () => {
    render(<TravelPanel {...props} directive={{ ...directive, originAssumed: true }} />);
    expect(screen.queryByRole("button", { name: "Measure travel" })).toBeNull();
  });

  it("says when the journey serves nothing in particular", () => {
    const { then: _omitted, ...homeward } = directive;
    render(<TravelPanel {...props} directive={{ ...homeward, title: "Drive home", toLocationId: "ctx-home" }} />);
    expect(screen.getByText(/Nothing in particular waits at the other end/)).toBeTruthy();
  });

  describe("an assumed origin", () => {
    it("offers to confirm the last known place, or somewhere else", () => {
      const save = vi.fn().mockResolvedValue(undefined);
      render(<TravelPanel {...props} saveEntityCommand={save} directive={{ ...directive, originAssumed: true }} />);
      expect(screen.getByText("Assuming you’re at Home.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Yes, I’m here" }));
      expect(save.mock.calls[0]![0].entity.currentSituation).toEqual({ locationId: "ctx-home" });
    });

    it("opens a location select on I'm somewhere else", () => {
      const save = vi.fn().mockResolvedValue(undefined);
      render(<TravelPanel {...props} saveEntityCommand={save} directive={{ ...directive, originAssumed: true }} />);
      fireEvent.click(screen.getByRole("button", { name: "I’m somewhere else" }));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "ctx-campus" } });
      expect(save.mock.calls[0]![0].entity.currentSituation).toEqual({ locationId: "ctx-campus" });
    });

    it("falls back to home by name when nothing has ever been asserted", () => {
      const neverAsserted: PortalState = {
        ...state,
        currentSituation: { ...state.currentSituation, locationId: null }
      };
      render(<TravelPanel {...props} state={neverAsserted} directive={{ ...directive, originAssumed: true }} />);
      expect(screen.getByText("Assuming you’re at Home.")).toBeTruthy();
    });
  });

  describe("On my way", () => {
    const underwayCommitment = { id: "c1", startsAt: "2026-08-18T11:00:00.000Z" };

    it("offers On my way for a leg to a protected commitment, and writes underway on the current place", () => {
      const save = vi.fn().mockResolvedValue(undefined);
      render(<TravelPanel {...props} saveEntityCommand={save} underwayCommitment={underwayCommitment} />);
      fireEvent.click(screen.getByRole("button", { name: "On my way" }));
      const command = save.mock.calls[0]![0];
      expect(command.entityType).toBe("current_availability");
      expect(command.entity.currentSituation.underway).toMatchObject({
        commitmentId: "c1",
        occurrenceStartsAt: "2026-08-18T11:00:00.000Z",
        fromLocationId: "ctx-home"
      });
      expect(typeof command.entity.currentSituation.underway.departedAt).toBe("string");
    });

    it("does not offer On my way for a leg with no protected commitment", () => {
      render(<TravelPanel {...props} />);
      expect(screen.queryByRole("button", { name: "On my way" })).toBeNull();
    });

    it("does not offer On my way from an assumed origin, where the place itself is unconfirmed", () => {
      render(
        <TravelPanel
          {...props}
          underwayCommitment={underwayCommitment}
          directive={{ ...directive, originAssumed: true }}
        />
      );
      expect(screen.queryByRole("button", { name: "On my way" })).toBeNull();
    });

    it("shows On your way copy and hides the button once underway for this commitment", () => {
      const underwayState: PortalState = {
        ...state,
        currentSituation: {
          ...state.currentSituation,
          underway: {
            commitmentId: "c1",
            occurrenceStartsAt: "2026-08-18T11:00:00.000Z",
            fromLocationId: "ctx-home",
            departedAt: "2026-08-18T09:55:00.000Z"
          }
        }
      };
      render(<TravelPanel {...props} state={underwayState} underwayCommitment={underwayCommitment} />);
      expect(screen.getByText("On your way to Campus.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "On my way" })).toBeNull();
    });

    it("does not offer On my way when there is no known origin (no situation location, no home)", () => {
      // The review finding this guards: without this check, the button wrote `underway.fromLocationId`
      // as the destination itself (falling back to `directive.toLocationId`), so arriving there could
      // never differ from the recorded origin and underway would never clear.
      const noOrigin: PortalState = {
        ...state,
        settings: { ...state.settings, homeLocationId: undefined },
        currentSituation: { ...state.currentSituation, locationId: null }
      };
      render(<TravelPanel {...props} state={noOrigin} underwayCommitment={underwayCommitment} />);
      expect(screen.queryByRole("button", { name: "On my way" })).toBeNull();
    });

    it("still offers On my way when underway names a different occurrence of the same commitment", () => {
      const otherOccurrence: PortalState = {
        ...state,
        currentSituation: {
          ...state.currentSituation,
          underway: {
            commitmentId: "c1",
            occurrenceStartsAt: "2026-08-17T11:00:00.000Z",
            fromLocationId: "ctx-home",
            departedAt: "2026-08-17T09:55:00.000Z"
          }
        }
      };
      render(<TravelPanel {...props} state={otherOccurrence} underwayCommitment={underwayCommitment} />);
      expect(screen.getByRole("button", { name: "On my way" })).toBeTruthy();
    });
  });
});
