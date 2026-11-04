// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { render, screen, within } from "@/test/render";
import type { NowCandidate } from "@/features/now/now-model";
import { ReachableList } from "./reachable-list";

const now = new Date("2026-08-18T10:00:00.000Z");
const base = createSeedState(now);
const state: PortalState = {
  ...base,
  conditionDefinitions: [
    {
      id: "ctx-campus",
      name: "Campus",
      kind: "location",
      status: "active",
      pathways: [],
      portability: "fixed",
      grants: [],
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      channels: []
    }
  ]
};

const candidate = (id: string, extra: Partial<NowCandidate> = {}): NowCandidate => ({
  action: { ...base.actions[0]!, id, title: id },
  eligible: false,
  exclusionReasons: [],
  recommendedMinutes: null,
  totalScore: 0,
  scoreComponents: {},
  ...extra
});

const trip = {
  toLocationId: "ctx-campus",
  travelMinutes: 18,
  returnMinutes: 0,
  mode: "car" as const,
  source: "measured" as const,
  bundleSize: 1,
  windowMinutes: 120,
  costMinutes: 18,
  opportunityMinutes: null,
  avoidableMinutes: 0
};

const reachableVia = {
  status: "no" as const,
  missing: [],
  unknowns: [],
  unmetPreferences: [],
  reachableVia: { locationId: "ctx-campus", travelMinutes: 18, mode: "car" as const }
};

const group = (name: string) => screen.getByRole("heading", { name }).closest("section")!;

describe("ReachableList", () => {
  it("says where a costed trip goes, how long the journey and the work are, and how well it is known", () => {
    render(
      <ReachableList
        worthTheTrip={[candidate("Print the forms", { trip, recommendedMinutes: 45 })]}
        notWorthTheTrip={[]}
        state={state}
      />
    );
    const section = group("Worth the trip");
    expect(within(section).getByText("1")).toBeTruthy();
    expect(within(section).getByText(/Campus · 18 min there \(measured\) · 45 min once you are there/)).toBeTruthy();
    // Nothing avoidable means no later moment is nearer, which is exactly when a trip costs nothing.
    expect(within(section).getByText(/You won't be near there again today\./)).toBeTruthy();
  });

  it("charges a journey only for what a later moment would have saved", () => {
    render(
      <ReachableList
        worthTheTrip={[
          candidate("Print the forms", { trip: { ...trip, avoidableMinutes: 36 }, recommendedMinutes: 45 })
        ]}
        notWorthTheTrip={[]}
        state={state}
      />
    );
    expect(screen.getByText(/Going later would save 36 min of travel\./)).toBeTruthy();
    expect(screen.queryByText(/You won't be near there again today/)).toBeNull();
  });

  it("separates what the engine refused a journey for, and says which reason applies", () => {
    render(
      <ReachableList
        worthTheTrip={[]}
        notWorthTheTrip={[
          candidate("Collect the parcel", {
            tripReason: "no_mode",
            conditionMatch: { status: "no", missing: ["ctx-campus"], unknowns: [], unmetPreferences: [] }
          }),
          candidate("Return the book", { tripReason: "no_window", conditionMatch: reachableVia })
        ]}
        state={state}
      />
    );
    const section = group("Not worth it right now");
    expect(within(section).getByText("2")).toBeTruthy();
    expect(within(section).getByText("Campus · no way to travel there")).toBeTruthy();
    expect(
      within(section).getByText("Campus · about 18 minutes away · nothing would fit once you arrived")
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Worth the trip" })).toBeNull();
  });

  it("keeps the old wording for a stored result with no verdict on the journey either way", () => {
    render(
      <ReachableList
        worthTheTrip={[]}
        notWorthTheTrip={[candidate("Read it", { conditionMatch: reachableVia })]}
        state={state}
      />
    );
    expect(screen.getByRole("heading", { name: "Possible if you travel" })).toBeTruthy();
    expect(screen.getByText("Campus · about 18 minutes away")).toBeTruthy();
  });
});
