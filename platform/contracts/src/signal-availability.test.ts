import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SUBJECTS,
  FRESHNESS_MODES,
  MOTION_STATES,
  ORIGINS,
  PRESENCE_VALUES,
  ROUTE_TIERS,
  SIGNAL_NAMES,
  SLOT_BY,
  TIER_CEILING,
  describeFeedProblems,
  isRoute,
  type Anchor,
  type EvidenceItem,
  type SignalFeed
} from "./signal-availability.js";

describe("signal-availability vocabularies", () => {
  it("are frozen and hold the agreed values", () => {
    for (const list of [
      SIGNAL_NAMES,
      ROUTE_TIERS,
      ORIGINS,
      MOTION_STATES,
      PRESENCE_VALUES,
      SLOT_BY,
      FRESHNESS_MODES,
      EVIDENCE_SUBJECTS
    ])
      expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(TIER_CEILING)).toBe(true);
    expect(MOTION_STATES).toEqual(["stationary", "walking", "running", "cycling", "automotive", "unknown"]);
    expect(PRESENCE_VALUES).toEqual(["home", "away"]);
    expect(ROUTE_TIERS).toEqual(["live", "periodic", "import", "inferred"]);
    expect(SLOT_BY).toEqual(["origin", "device", "route"]);
    expect(FRESHNESS_MODES).toEqual(["decay", "refreshed-held"]);
    expect(EVIDENCE_SUBJECTS).toEqual(["self", "anyone", "other"]);
    expect(ORIGINS).toEqual([
      "phone",
      "computer",
      "home_net",
      "home_hub",
      "vehicle",
      "account",
      "files",
      "cloud",
      "room_sensor",
      "carried"
    ]);
    expect(SIGNAL_NAMES).toHaveLength(12);
  });

  it("caps every tier at 0.95 or less, in descending order of trust", () => {
    expect(Object.keys(TIER_CEILING).sort()).toEqual([...ROUTE_TIERS].sort());
    for (const tier of ROUTE_TIERS) expect(TIER_CEILING[tier]).toBeLessThanOrEqual(0.95);
    expect(TIER_CEILING).toEqual({ live: 0.8, periodic: 0.7, import: 0.6, inferred: 0.4 });
  });

  it("types accept the agreed shapes (checked by typecheck)", () => {
    const anchors: Anchor[] = [
      { t: "cond", id: "c1" },
      { t: "place", id: "p1" },
      { t: "cell", gh7: "gcpvj0d" },
      { t: "node", site: "home", path: "kitchen/sink" }
    ];
    const feed: SignalFeed = {
      signal: "presence_home",
      tier: "live",
      kinds: ["state"],
      slotBy: "route",
      weight: 0.5,
      freshness: "refreshed-held",
      staleAfterMinutes: 10,
      holds: { closedBy: ["leave"], halfLifeMinutes: Infinity, maxMinutes: Infinity }
    };
    const item: EvidenceItem = {
      source: "s",
      origin: "home_hub",
      signal: "presence_home",
      value: "home",
      observedAt: "2026-01-01T00:00:00Z",
      ingestedAt: "2026-01-01T00:00:01Z",
      tier: "live",
      weight: 0.5,
      subject: "other"
    };
    expect(anchors).toHaveLength(4);
    expect(feed.holds?.halfLifeMinutes).toBe(Infinity);
    expect(item.subject).toBe("other");
  });
});

describe("isRoute and feed problems", () => {
  it("treats an entry with no availability as a projection", () => {
    expect(isRoute({})).toBe(false);
  });

  it("requires staleAfterMinutes for refreshed-held", () => {
    const base = { signal: "presence_home", weight: 0.5 } as unknown as SignalFeed;
    expect(describeFeedProblems({ ...base, freshness: "refreshed-held" })).toHaveLength(1);
    expect(describeFeedProblems({ ...base, freshness: "refreshed-held", staleAfterMinutes: 0 })).toHaveLength(1);
    expect(describeFeedProblems({ ...base, freshness: "refreshed-held", staleAfterMinutes: 60 })).toEqual([]);
    expect(describeFeedProblems({ ...base, freshness: "decay" })).toEqual([]);
  });
});
