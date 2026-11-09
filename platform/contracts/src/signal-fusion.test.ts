import { describe, expect, it } from "vitest";
import {
  canonicalValueKey,
  classifySource,
  evidenceConfidence,
  evidenceFreshness,
  fuseContinuous,
  fuseDeviceAttention,
  fuseLedger,
  fuseState,
  routeEntries,
  scaleConsumerWeight,
  type AvailabilityBookView,
  type CoverageClaim,
  type FusionItem,
  type LedgerRowRef
} from "./signal-fusion.js";
import { TIER_CEILING, type Origin, type RouteTier, type SourceAvailability } from "./signal-availability.js";

const NOW = "2026-11-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ago = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();
const ahead = (minutes: number) => ago(-minutes);

function item(over: Partial<FusionItem> = {}): FusionItem {
  return {
    source: "s1",
    origin: "phone",
    signal: "presence_home",
    value: "home",
    observedAt: ago(0),
    ingestedAt: ago(0),
    tier: "live",
    weight: 0.8,
    ...over
  };
}

/** Seeded generator, so a failing property reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIALS = 200;
const EPS = 1e-12;

const availability = (over: Partial<SourceAvailability> = {}): SourceAvailability => ({
  delivery: "live",
  origin: "phone",
  expectedEveryMinutes: 10,
  feeds: [],
  recoveryHint: "Check the collector, then post one heartbeat.",
  ...over
});
const book = (over: Partial<AvailabilityBookView> = {}): AvailabilityBookView => ({
  firstSeenAt: ago(60 * 24 * 10),
  lastLiveIngestAt: ago(5),
  devices: {},
  ...over
});

describe("all-absent baseline", () => {
  it("fuses nothing to nothing", () => {
    const s = fuseState("presence_home", [], NOW);
    expect(s).toMatchObject({
      value: null,
      conf: 0,
      supportBest: 0,
      coverage: 0,
      contested: false,
      support: [],
      slots: []
    });
    expect(fuseContinuous("weather", [], NOW)).toEqual({
      signal: "weather",
      value: null,
      conf: 0,
      source: null,
      origin: null,
      tier: null
    });
    expect(fuseDeviceAttention([], NOW)).toEqual({});
    expect(fuseLedger({ now: NOW, window: { from: ago(60 * 24), to: NOW }, rows: [], claims: [] })).toEqual({
      completeness: 0,
      scopes: [],
      trust: null
    });
    expect(classifySource({ availability: availability() }, undefined, NOW)).toEqual({
      state: "absent",
      ageMinutes: null
    });
  });

  it("treats items of another signal, and items too old, as absent", () => {
    const s = fuseState(
      "presence_home",
      [item({ signal: "position", value: { t: "cell", gh7: "gcpvj0d" } }), item({ observedAt: ago(361) })],
      NOW
    );
    expect(s.value).toBeNull();
    expect(s.coverage).toBe(0);
  });
});

describe("classifySource", () => {
  const live = { availability: availability() };
  it("is undefined for an entry with no availability, and routeEntries skips it", () => {
    expect(classifySource({}, book(), NOW)).toBeUndefined();
    const sources = { derived: {}, a: live, b: { availability: availability({ delivery: "import" }) } };
    expect(routeEntries(sources).map(([name]) => name)).toEqual(["a", "b"]);
  });

  it("is absent with no firstSeenAt, no book, or a retired source", () => {
    expect(classifySource(live, null, NOW)?.state).toBe("absent");
    expect(classifySource(live, book({ firstSeenAt: null }), NOW)?.state).toBe("absent");
    expect(classifySource(live, book({ retiredAt: ago(1) }), NOW)?.state).toBe("absent");
  });

  it("is live or periodic within silentAfter (default 3 x expectedEvery), silent beyond it", () => {
    expect(classifySource(live, book({ lastLiveIngestAt: ago(30) }), NOW)).toEqual({ state: "live", ageMinutes: 30 });
    const silent = classifySource(live, book({ lastLiveIngestAt: ago(31) }), NOW);
    expect(silent).toEqual({
      state: "silent",
      ageMinutes: 31,
      recoveryHint: "Check the collector, then post one heartbeat."
    });
    const periodic = {
      availability: availability({ delivery: "periodic", expectedEveryMinutes: 60, silentAfterMinutes: 500 })
    };
    expect(classifySource(periodic, book({ lastLiveIngestAt: ago(500) }), NOW)?.state).toBe("periodic");
    expect(classifySource(periodic, book({ lastLiveIngestAt: ago(501) }), NOW)?.state).toBe("silent");
  });

  it("never calls a source silent when it declares no cadence", () => {
    const { expectedEveryMinutes: _omitted, ...rest } = availability();
    const noCadence = { availability: rest };
    expect(classifySource(noCadence, book({ lastLiveIngestAt: ago(99999) }), NOW)?.state).toBe("live");
  });

  it("is silent when seen but never delivered live", () => {
    expect(classifySource(live, book({ lastLiveIngestAt: null }), NOW)).toMatchObject({
      state: "silent",
      ageMinutes: null
    });
  });

  it("is errored when a device's error is newer than its own ok, naming that device", () => {
    const devices = {
      a: { okAt: ago(10), error: { at: ago(20) } },
      b: { okAt: ago(10), error: { at: ago(3) } },
      c: { okAt: null, error: { at: ago(50) } }
    };
    expect(classifySource(live, book({ devices }), NOW)).toMatchObject({ state: "errored", device: "b" });
    // Another device being ok does not clear b: only b's own ok does.
    expect(classifySource(live, book({ devices: { b: { okAt: ago(2), error: { at: ago(3) } } } }), NOW)?.state).toBe(
      "live"
    );
    // Equal times are not an error.
    expect(classifySource(live, book({ devices: { b: { okAt: ago(3), error: { at: ago(3) } } } }), NOW)?.state).toBe(
      "live"
    );
  });

  it("checks errored before import_only, and an import source is never silent", () => {
    const imp = { availability: availability({ delivery: "import" }) };
    expect(classifySource(imp, book({ lastLiveIngestAt: null }), NOW)).toEqual({
      state: "import_only",
      ageMinutes: null
    });
    expect(classifySource(imp, book({ devices: { d: { okAt: null, error: { at: ago(1) } } } }), NOW)?.state).toBe(
      "errored"
    );
  });

  it("clamps an ingest time in the future to age 0", () => {
    expect(classifySource(live, book({ lastLiveIngestAt: ahead(3) }), NOW)).toEqual({ state: "live", ageMinutes: 0 });
  });
});

describe("freshness and confidence", () => {
  it("decays by half-life and is 0 past the max age", () => {
    expect(evidenceFreshness({ ageMinutes: 30, halfLifeMinutes: 30, maxMinutes: 360 })).toBeCloseTo(0.5, 12);
    expect(evidenceFreshness({ ageMinutes: 60, halfLifeMinutes: 30, maxMinutes: 360 })).toBeCloseTo(0.25, 12);
    expect(evidenceFreshness({ ageMinutes: 360, halfLifeMinutes: 30, maxMinutes: 360 })).toBeGreaterThan(0);
    expect(evidenceFreshness({ ageMinutes: 361, halfLifeMinutes: 30, maxMinutes: 360 })).toBe(0);
  });

  it("gives f = 1 at age 0 for any half-life, and 0 above age 0 for a half-life of 0 or less", () => {
    for (const halfLifeMinutes of [0, -5, 1, 30, Infinity])
      expect(evidenceFreshness({ ageMinutes: 0, halfLifeMinutes, maxMinutes: 60 })).toBe(1);
    expect(evidenceFreshness({ ageMinutes: 1, halfLifeMinutes: 0, maxMinutes: 60 })).toBe(0);
    const held = item({ holds: { closedBy: [], halfLifeMinutes: 0, maxMinutes: 60 } });
    expect(fuseState("presence_home", [held], NOW).supportBest).toBe(0.8);
  });

  it("gives f = 1 for an infinite half-life, up to the max age", () => {
    expect(evidenceFreshness({ ageMinutes: 100000, halfLifeMinutes: Infinity, maxMinutes: Infinity })).toBe(1);
    expect(evidenceFreshness({ ageMinutes: 11, halfLifeMinutes: Infinity, maxMinutes: 10 })).toBe(0);
  });

  it("refreshed-held is 1 within staleAfterMinutes of the last re-post, else 0", () => {
    const base = {
      ageMinutes: 9999,
      halfLifeMinutes: 1,
      maxMinutes: 1,
      mode: "refreshed-held" as const,
      staleAfterMinutes: 10
    };
    expect(evidenceFreshness({ ...base, sinceRepostMinutes: 10 })).toBe(1);
    expect(evidenceFreshness({ ...base, sinceRepostMinutes: 10.01 })).toBe(0);
    expect(evidenceFreshness({ ...base, staleAfterMinutes: undefined, sinceRepostMinutes: 0 })).toBe(0);
  });

  it("clamps the weight to the tier ceiling at read time", () => {
    expect(evidenceConfidence("inferred", 1, 1)).toBe(0.4);
    expect(evidenceConfidence("live", 7, 1)).toBe(0.8);
    expect(evidenceConfidence("live", -3, 1)).toBe(0);
    expect(evidenceConfidence("live", Number.NaN, 1)).toBe(0);
    expect(evidenceConfidence("periodic", 0.5, 0.5)).toBeCloseTo(0.25, 12);
  });
});

describe("fuseState worked examples", () => {
  it("decay: a 30 minute old live presence at weight 0.8 carries c = 0.4", () => {
    const s = fuseState("presence_home", [item({ observedAt: ago(30) })], NOW);
    expect(s.value).toBe("home");
    expect(s.supportBest).toBeCloseTo(0.4, 12);
    expect(s.conf).toBeCloseTo(0.4, 12);
    expect(s.coverage).toBeCloseTo(0.4, 12);
  });

  it("skew: an item 6 minutes ahead is not evidence, 4 minutes ahead counts at full strength", () => {
    expect(fuseState("presence_home", [item({ observedAt: ahead(6) })], NOW).value).toBeNull();
    const near = fuseState("presence_home", [item({ observedAt: ahead(4) })], NOW);
    expect(near.supportBest).toBeCloseTo(0.8, 12);
  });

  it("a future item does not supersede the real newest one", () => {
    const s = fuseState(
      "presence_home",
      [item({ observedAt: ago(1), value: "home" }), item({ observedAt: ahead(60), value: "away" })],
      NOW
    );
    expect(s.value).toBe("home");
  });

  it("P1: ten items from one route give the ceiling once, not ten times", () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ observedAt: ago(i), weight: 1 }));
    expect(fuseState("presence_home", items, NOW).supportBest).toBe(0.8);
  });

  it("P1 read-time clamp: an extension feed declaring weight 9 on an inferred route gives 0.4", () => {
    const s = fuseState("presence_home", [item({ tier: "inferred", weight: 9, source: "ext-net" })], NOW);
    expect(s.supportBest).toBe(0.4);
    expect(s.supportBest).toBe(TIER_CEILING.inferred);
  });

  it("two origins combine by noisy-OR, and the cap holds at 0.95", () => {
    const two = fuseState(
      "presence_home",
      [item({ origin: "phone" }), item({ source: "s2", origin: "computer", tier: "periodic", weight: 0.7 })],
      NOW
    );
    expect(two.supportBest).toBeCloseTo(1 - 0.2 * 0.3, 12);
    const three = fuseState(
      "presence_home",
      [
        item({ origin: "phone" }),
        item({ source: "s2", origin: "computer" }),
        item({ source: "s3", origin: "home_hub" })
      ],
      NOW
    );
    expect(1 - 0.2 * 0.2 * 0.2).toBeGreaterThan(0.95);
    expect(three.supportBest).toBe(0.95);
    expect(three.coverage).toBeCloseTo(1 - 0.2 ** 3, 12);
  });

  it("two routes of one origin are one slot (the newest), not two votes", () => {
    const s = fuseState(
      "presence_home",
      [item({ source: "a", observedAt: ago(2) }), item({ source: "b", observedAt: ago(1), value: "away" })],
      NOW
    );
    expect(s.value).toBe("away");
    expect(s.slots).toHaveLength(1);
    expect(s.contested).toBe(false);
  });

  it("a tie on observation time goes to the higher c, then the source name", () => {
    const t = ago(0);
    const hi = fuseState(
      "presence_home",
      [
        item({ source: "a", observedAt: t, weight: 0.3 }),
        item({ source: "b", observedAt: t, weight: 0.8, value: "away" })
      ],
      NOW
    );
    expect(hi.value).toBe("away");
    const same = fuseState(
      "presence_home",
      [item({ source: "b", observedAt: t, value: "away" }), item({ source: "a", observedAt: t })],
      NOW
    );
    expect(same.value).toBe("home");
  });

  it("conf is the margin between best and runner-up across origins, and the state is contested", () => {
    const s = fuseState(
      "presence_home",
      [
        item({ origin: "phone", value: "home" }),
        item({ source: "s2", origin: "computer", tier: "periodic", weight: 0.7, value: "away" })
      ],
      NOW
    );
    expect(s.value).toBe("home");
    expect(s.conf).toBeCloseTo(0.1, 12);
    expect(s.supportBest).toBeCloseTo(0.8, 12);
    expect(s.contested).toBe(true);
    expect(s.support.map((x) => x.key)).toEqual(['"home"', '"away"']);
  });

  it("a dead heat has conf 0 and a stable winner", () => {
    const items = [item({ origin: "phone", value: "home" }), item({ source: "s2", origin: "computer", value: "away" })];
    const a = fuseState("presence_home", items, NOW);
    const b = fuseState("presence_home", [...items].reverse(), NOW);
    expect(a.conf).toBe(0);
    expect(b.value).toBe(a.value);
  });

  it("agreeing origins raise conf over a lone dissenter", () => {
    const s = fuseState(
      "presence_home",
      [
        item({ origin: "phone" }),
        item({ source: "s2", origin: "home_net", tier: "inferred", weight: 0.4 }),
        item({ source: "s3", origin: "computer", value: "away", tier: "periodic", weight: 0.7 })
      ],
      NOW
    );
    // home: 1 - 0.2 x 0.6 = 0.88; away: 0.7
    expect(s.value).toBe("home");
    expect(s.conf).toBeCloseTo(0.88 - 0.7, 12);
  });

  it("subject is ignored by fuseState", () => {
    const selfItems = [
      item({ subject: "self" }),
      item({ source: "s2", origin: "computer", value: "away", tier: "periodic", weight: 0.7 })
    ];
    const mixed = [
      item({ subject: "other" }),
      item({ source: "s2", origin: "computer", value: "away", tier: "periodic", weight: 0.7, subject: "anyone" })
    ];
    expect(fuseState("presence_home", mixed, NOW)).toEqual(fuseState("presence_home", selfItems, NOW));
  });

  it("compares object values by content, whatever the key order", () => {
    const a = { t: "cell", gh7: "gcpvj0d" };
    const b = { gh7: "gcpvj0d", t: "cell" };
    expect(canonicalValueKey(a)).toBe(canonicalValueKey(b));
    const s = fuseState(
      "position",
      [
        item({ signal: "position", value: a }),
        item({ signal: "position", source: "s2", origin: "computer", value: b })
      ],
      NOW
    );
    expect(s.support).toHaveLength(1);
    expect(s.contested).toBe(false);
  });
});

describe("held states (same-origin closing)", () => {
  const holds = { closedBy: ["region_leave"], halfLifeMinutes: Infinity, maxMinutes: Infinity };
  const enter = (over: Partial<FusionItem> = {}) =>
    item({ kind: "region_enter", observedAt: ago(600), holds, ...over });

  it("holds past the sampled max age, with no decay at an infinite half-life", () => {
    expect(fuseState("presence_home", [enter()], NOW).supportBest).toBe(0.8);
    expect(fuseState("presence_home", [item({ observedAt: ago(600) })], NOW).value).toBeNull();
  });

  it("decays at the hold half-life and ends at maxMinutes", () => {
    const h = { closedBy: [], halfLifeMinutes: 360, maxMinutes: 1080 };
    expect(fuseState("presence_home", [enter({ observedAt: ago(360), holds: h })], NOW).supportBest).toBeCloseTo(
      0.4,
      12
    );
    expect(fuseState("presence_home", [enter({ observedAt: ago(1081), holds: h })], NOW).value).toBeNull();
  });

  it("is closed by a closing kind from another route of the same origin", () => {
    const leave = item({
      source: "s9",
      kind: "region_leave",
      observedAt: ago(5),
      value: "away",
      weight: 0,
      tier: "live"
    });
    const s = fuseState("presence_home", [enter(), leave], NOW);
    expect(s.value).toBeNull(); // enter is closed, and the leave carries weight 0
  });

  it("is not closed by the same kind from a different origin", () => {
    const leave = item({
      source: "s9",
      origin: "computer",
      kind: "region_leave",
      observedAt: ago(5),
      value: "away",
      weight: 0
    });
    expect(fuseState("presence_home", [enter(), leave], NOW).value).toBe("home");
  });

  it("is closed by a fresher opposite value from the same origin only", () => {
    const sample = item({ source: "s9", observedAt: ago(5), value: "away", weight: 0.5 });
    expect(fuseState("presence_home", [enter(), sample], NOW).value).toBe("away");
    const other = { ...sample, origin: "computer" as Origin };
    const s = fuseState("presence_home", [enter(), other], NOW);
    expect(s.value).toBe("home");
    expect(s.contested).toBe(true);
  });

  it("an older same-origin opposite value does not close it", () => {
    const older = item({ source: "s9", observedAt: ago(700), value: "away" });
    expect(fuseState("presence_home", [enter(), older], NOW).value).toBe("home");
  });
});

describe("slotBy", () => {
  const two = (slotBy: "origin" | "device" | "route", labelB = "kitchen") => [
    item({ slotBy, device: "d1", label: "kitchen" }),
    item({ slotBy, device: "d2", label: labelB, observedAt: ago(1) })
  ];

  it("origin: two devices of one origin are one slot", () => {
    const s = fuseState("presence_home", two("origin"), NOW);
    expect(s.slots).toHaveLength(1);
    expect(s.supportBest).toBe(0.8);
  });

  it("device: two devices are independent slots, and P1 holds per slot", () => {
    const s = fuseState("presence_home", two("device"), NOW);
    expect(s.slots.map((x) => x.slot)).toEqual(["phone:d1", "phone:d2"]);
    expect(s.supportBest).toBe(0.95); // 1 - 0.2 x 0.2 = 0.96, capped
    const many = Array.from({ length: 6 }, (_, i) => item({ slotBy: "device", device: "d1", observedAt: ago(i) }));
    expect(fuseState("presence_home", many, NOW).supportBest).toBe(0.8);
  });

  it("route: two sensors on one device stay independent; one device and one label is one slot", () => {
    const sameDevice = [
      item({ slotBy: "route", device: "d1", label: "a" }),
      item({ slotBy: "route", device: "d1", label: "b" })
    ];
    expect(fuseState("presence_home", sameDevice, NOW).slots.map((x) => x.slot)).toEqual(["phone:d1:a", "phone:d1:b"]);
    const repeat = [
      item({ slotBy: "route", device: "d1", label: "a" }),
      item({ slotBy: "route", device: "d1", label: "a", observedAt: ago(3) })
    ];
    expect(fuseState("presence_home", repeat, NOW).slots).toHaveLength(1);
  });

  it("contested: slots of one origin that disagree count as dissent under slotBy device and route, not under origin", () => {
    const pair = (slotBy: "origin" | "device" | "route") => [
      item({ slotBy, device: "d1", label: "a", value: "home" }),
      item({ slotBy, device: "d2", label: "b", value: "away", observedAt: ago(1) })
    ];
    expect(fuseState("presence_home", pair("origin"), NOW).contested).toBe(false);
    expect(fuseState("presence_home", pair("device"), NOW).contested).toBe(true);
    expect(fuseState("presence_home", pair("route"), NOW).contested).toBe(true);
    const sameDeviceRoutes = [
      item({ slotBy: "route", device: "d1", label: "a", value: "home" }),
      item({ slotBy: "route", device: "d1", label: "b", value: "away" })
    ];
    expect(fuseState("presence_home", sameDeviceRoutes, NOW).contested).toBe(true);
  });

  it("route: a missing device or label keys as _", () => {
    const s = fuseState("presence_home", [item({ slotBy: "route" })], NOW);
    expect(s.slots[0]!.slot).toBe("phone:_:_");
  });
});

describe("refreshed-held", () => {
  const held = (repostedMinutesAgo: number, over: Partial<FusionItem> = {}) =>
    item({
      origin: "home_hub",
      freshness: "refreshed-held",
      staleAfterMinutes: 10,
      observedAt: ago(repostedMinutesAgo),
      lastRepostedAt: ago(repostedMinutesAgo),
      ...over
    });

  it("is full strength within staleAfterMinutes of the last re-post and nothing after", () => {
    expect(fuseState("presence_home", [held(10)], NOW).supportBest).toBe(0.8);
    expect(fuseState("presence_home", [held(11)], NOW).value).toBeNull();
  });

  it("uses lastRepostedAt, not observedAt, so a long-held state stays alive while it is re-posted", () => {
    const s = fuseState("presence_home", [held(0, { observedAt: ago(3000), lastRepostedAt: ago(4) })], NOW);
    expect(s.supportBest).toBe(0.8);
  });

  it("a re-post in the future is not evidence", () => {
    expect(fuseState("presence_home", [held(-30)], NOW).value).toBeNull();
  });

  it("never rises with age (P3 for the step)", () => {
    let last = Infinity;
    for (let m = 0; m <= 30; m++) {
      const s = fuseState(
        "presence_home",
        [held(0, { observedAt: ago(0), lastRepostedAt: ago(0) })],
        ahead(m)
      ).supportBest;
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    expect(last).toBe(0);
  });
});

describe("device_attention and continuous signals", () => {
  const dev = (deviceId: string, category: string, over: Partial<FusionItem> = {}) =>
    item({ signal: "device_attention", value: { deviceClass: "computer", deviceId, category }, ...over });

  it("fuses per device and never across devices", () => {
    const out = fuseDeviceAttention(
      [
        dev("pc", "work", { observedAt: ago(1) }),
        dev("pc", "play", { observedAt: ago(0) }),
        dev("phone", "social", { source: "s2", origin: "computer", observedAt: ago(0) })
      ],
      NOW
    );
    expect(Object.keys(out)).toEqual(["pc", "phone"]);
    expect((out.pc!.value as { category: string }).category).toBe("play"); // successive samples supersede, no dissent
    expect(out.pc!.contested).toBe(false);
    expect((out.phone!.value as { category: string }).category).toBe("social");
  });

  it("continuous: picks one item with conf = its own c, not a vote", () => {
    const w = (over: Partial<FusionItem>) => item({ signal: "weather", value: { tempC: 10 }, ...over });
    const c = fuseContinuous(
      "weather",
      [
        w({ origin: "cloud", tier: "periodic", weight: 0.7, value: { tempC: 12 } }),
        w({ source: "s2", origin: "home_hub", weight: 0.8, value: { tempC: 11 } })
      ],
      NOW
    );
    expect(c.value).toEqual({ tempC: 11 });
    expect(c.conf).toBe(0.8);
    expect(c.tier).toBe("live");
  });

  it("continuous: the design's literal 'highest tier' rule would break P3, so it picks by c", () => {
    // live weight 0.1 (c = 0.1 until it expires at 360 min) vs import weight 0.6.
    const live = item({ signal: "weather", value: { tempC: 1 }, weight: 0.1, observedAt: ago(0) });
    const imp = item({
      signal: "weather",
      source: "s2",
      origin: "files",
      tier: "import",
      weight: 0.6,
      value: { tempC: 2 },
      observedAt: ago(0)
    });
    const a = fuseContinuous("weather", [live, imp], NOW);
    expect(a.conf).toBe(0.6);
    // Moving on never raises conf, even across the live item's expiry.
    let last = Infinity;
    for (const m of [0, 100, 300, 359, 361, 1000]) {
      const c = fuseContinuous("weather", [live, imp], ahead(m)).conf;
      expect(c).toBeLessThanOrEqual(last + EPS);
      last = c;
    }
  });
});

/* -------------------------------------------------------------------- properties */

const SOURCES: Record<string, { origin: Origin; tier: RouteTier }> = {
  s1: { origin: "phone", tier: "live" },
  s2: { origin: "phone", tier: "periodic" },
  s3: { origin: "computer", tier: "periodic" },
  s4: { origin: "home_hub", tier: "live" },
  s5: { origin: "files", tier: "import" },
  s6: { origin: "home_net", tier: "inferred" }
};
const SOURCE_NAMES = Object.keys(SOURCES);

function genItems(
  rand: () => number,
  opts: { holds?: boolean; refreshed?: boolean; futureMin?: number } = {}
): FusionItem[] {
  const n = 1 + Math.floor(rand() * 9);
  const out: FusionItem[] = [];
  for (let i = 0; i < n; i++) {
    const source = SOURCE_NAMES[Math.floor(rand() * SOURCE_NAMES.length)]!;
    const { origin, tier } = SOURCES[source]!;
    const observedAt = ago(-(opts.futureMin ?? 0) * rand() + rand() * 700);
    const it: FusionItem = {
      source,
      origin,
      tier,
      signal: "presence_home",
      value: rand() < 0.5 ? "home" : "away",
      observedAt,
      ingestedAt: observedAt,
      weight: rand() * 1.5
    };
    if (opts.holds && rand() < 0.3) {
      it.kind = "enter";
      it.holds = { closedBy: ["leave"], halfLifeMinutes: rand() < 0.5 ? Infinity : 200, maxMinutes: 1080 };
    } else if (opts.holds && rand() < 0.15) it.kind = "leave";
    if (opts.refreshed && rand() < 0.3) {
      it.freshness = "refreshed-held";
      it.staleAfterMinutes = 5 + rand() * 120;
      it.lastRepostedAt = new Date(Math.min(NOW_MS, Date.parse(observedAt) + rand() * 300 * 60_000)).toISOString();
    }
    out.push(it);
  }
  return out;
}

const supportMap = (items: FusionItem[], now: string) => {
  const s = fuseState("presence_home", items, now);
  return { s, map: new Map(s.support.map((x) => [x.key, x.support])) };
};

describe("property P1: a route never pushes support past its ceiling", () => {
  it("one route, any number of items, any weights", () => {
    const rand = rng(11);
    for (let t = 0; t < TRIALS; t++) {
      const source = SOURCE_NAMES[Math.floor(rand() * SOURCE_NAMES.length)]!;
      const { origin, tier } = SOURCES[source]!;
      const n = 1 + Math.floor(rand() * 30);
      const items = Array.from({ length: n }, () =>
        item({
          source,
          origin,
          tier,
          value: rand() < 0.5 ? "home" : "away",
          observedAt: ago(rand() * 300),
          weight: rand() * 5
        })
      );
      const s = fuseState("presence_home", items, NOW);
      for (const x of s.support) expect(x.support).toBeLessThanOrEqual(TIER_CEILING[tier] + EPS);
      expect(s.coverage).toBeLessThanOrEqual(TIER_CEILING[tier] + EPS);
    }
  });

  it("an origin never exceeds its highest ceiling, and each slot respects its own (device and route slots too)", () => {
    const rand = rng(12);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand).map((i) => ({ ...i, slotBy: "origin" as const }));
      const s = fuseState("presence_home", items, NOW);
      for (const slot of s.slots) {
        const ceiling = Math.max(...items.filter((i) => i.origin === slot.origin).map((i) => TIER_CEILING[i.tier]));
        expect(slot.c).toBeLessThanOrEqual(ceiling + EPS);
      }
      const perSlot = items.map((i, k) => ({
        ...i,
        slotBy: "route" as const,
        device: `d${k % 3}`,
        label: `l${k % 2}`
      }));
      for (const slot of fuseState("presence_home", perSlot, NOW).slots) expect(slot.c).toBeLessThanOrEqual(0.8 + EPS);
    }
  });
});

describe("property P2: removing a whole slot never raises coverage or any support", () => {
  it("origin slots", () => {
    const rand = rng(21);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand, { holds: true, refreshed: true });
      const before = supportMap(items, NOW);
      for (const origin of new Set(items.map((i) => i.origin))) {
        const after = supportMap(
          items.filter((i) => i.origin !== origin),
          NOW
        );
        expect(after.s.coverage).toBeLessThanOrEqual(before.s.coverage + EPS);
        for (const [key, support] of after.map) expect(support).toBeLessThanOrEqual((before.map.get(key) ?? 0) + EPS);
      }
    }
  });

  it("route and device slots, without holds", () => {
    const rand = rng(22);
    for (let t = 0; t < TRIALS; t++) {
      const by = rand() < 0.5 ? ("device" as const) : ("route" as const);
      const items = genItems(rand, { refreshed: true }).map((i, k) => ({
        ...i,
        slotBy: by,
        device: `d${k % 3}`,
        label: `l${k % 2}`
      }));
      const before = supportMap(items, NOW);
      for (const slot of new Set(
        items.map((i) => (by === "device" ? `${i.origin}:${i.device}` : `${i.origin}:${i.device}:${i.label}`))
      )) {
        const keep = items.filter(
          (i) => (by === "device" ? `${i.origin}:${i.device}` : `${i.origin}:${i.device}:${i.label}`) !== slot
        );
        const after = supportMap(keep, NOW);
        expect(after.s.coverage).toBeLessThanOrEqual(before.s.coverage + EPS);
        for (const [key, support] of after.map) expect(support).toBeLessThanOrEqual((before.map.get(key) ?? 0) + EPS);
      }
    }
  });

  it("a worked counterexample: removing a route inside a shared origin slot CAN raise support", () => {
    // Route a (weight 0.1) is newer than route b (weight 0.8) on one origin: the slot belongs to a.
    const a = item({ source: "a", observedAt: ago(1), weight: 0.1 });
    const b = item({ source: "b", observedAt: ago(2), weight: 0.8 });
    const both = fuseState("presence_home", [a, b], NOW).supportBest;
    const alone = fuseState("presence_home", [b], NOW).supportBest;
    expect(both).toBeCloseTo(0.1 * 0.5 ** (1 / 30), 12);
    expect(alone).toBeCloseTo(0.8 * 0.5 ** (2 / 30), 12);
    expect(alone).toBeGreaterThan(both);
  });

  it("a worked counterexample: removing a closing route un-closes a held state", () => {
    const holds = { closedBy: ["leave"], halfLifeMinutes: Infinity, maxMinutes: Infinity };
    const enter = item({ kind: "enter", holds, observedAt: ago(90) });
    const leave = item({ source: "s9", kind: "leave", observedAt: ago(5), weight: 0 });
    expect(fuseState("presence_home", [enter, leave], NOW).supportBest).toBe(0);
    expect(fuseState("presence_home", [enter], NOW).supportBest).toBe(0.8);
  });
});

describe("property P3: moving now forward never raises support, coverage or a continuous c", () => {
  it("state signals, including held and refreshed-held", () => {
    const rand = rng(31);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand, { holds: true, refreshed: true, futureMin: 4 });
      const now1 = ahead(rand() * 1500);
      const a = supportMap(items, NOW);
      const b = supportMap(items, now1);
      expect(b.s.coverage).toBeLessThanOrEqual(a.s.coverage + EPS);
      for (const [key, support] of b.map) expect(support).toBeLessThanOrEqual((a.map.get(key) ?? 0) + EPS);
    }
  });

  it.each(["device", "route"] as const)("state signals under slotBy %s", (slotBy) => {
    const rand = rng(slotBy === "device" ? 33 : 34);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand, { holds: true, refreshed: true, futureMin: 4 }).map((i) => ({
        ...i,
        slotBy,
        device: `d${Math.floor(rand() * 3)}`,
        label: `l${Math.floor(rand() * 3)}`
      }));
      const a = supportMap(items, NOW);
      const b = supportMap(items, ahead(rand() * 1500));
      expect(b.s.coverage).toBeLessThanOrEqual(a.s.coverage + EPS);
      for (const [key, support] of b.map) expect(support).toBeLessThanOrEqual((a.map.get(key) ?? 0) + EPS);
    }
  });

  it("continuous signals", () => {
    const rand = rng(32);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand, { refreshed: true, futureMin: 4 }).map((i) => ({
        ...i,
        signal: "weather" as const,
        value: { tempC: Math.round(rand() * 30) }
      }));
      const a = fuseContinuous("weather", items, NOW).conf;
      const b = fuseContinuous("weather", items, ahead(rand() * 1500)).conf;
      expect(b).toBeLessThanOrEqual(a + EPS);
    }
  });

  it("holds only for items already observed: an item from the future of the earlier now may legitimately appear", () => {
    const later = item({ observedAt: ahead(60) });
    expect(fuseState("presence_home", [later], NOW).value).toBeNull();
    expect(fuseState("presence_home", [later], ahead(60)).supportBest).toBe(0.8);
  });
});

describe("property P4: conf is a bound", () => {
  it("conf <= support[best], and a consumer weight is <= consumerWeight x support[best]", () => {
    const rand = rng(41);
    for (let t = 0; t < TRIALS; t++) {
      const s = fuseState("presence_home", genItems(rand, { holds: true }), NOW);
      const cw = rand();
      expect(s.conf).toBeLessThanOrEqual(s.supportBest + EPS);
      expect(scaleConsumerWeight(cw, s.conf)).toBeLessThanOrEqual(cw * s.supportBest + EPS);
      expect(scaleConsumerWeight(cw, s.conf)).toBeLessThanOrEqual(cw + EPS);
    }
  });

  it("a worked case: 0.9 x conf 0.1 gives 0.09 and an out-of-range input is clamped", () => {
    expect(scaleConsumerWeight(0.9, 0.1)).toBeCloseTo(0.09, 12);
    expect(scaleConsumerWeight(5, 5)).toBe(1);
    expect(scaleConsumerWeight(0.5, Number.NaN)).toBe(0);
  });
});

describe("property P5: state never enters fusion", () => {
  it("a route whose items are all past the max age is identical to an absent route", () => {
    const rand = rng(51);
    for (let t = 0; t < TRIALS; t++) {
      const items = genItems(rand).filter((i) => i.origin !== "files");
      const stale = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
        item({
          source: "s5",
          origin: "files",
          tier: "import",
          weight: rand(),
          value: rand() < 0.5 ? "home" : "away",
          observedAt: ago(361 + rand() * 5000)
        })
      );
      expect(fuseState("presence_home", [...items, ...stale], NOW)).toEqual(fuseState("presence_home", items, NOW));
    }
  });

  it("a superseded old item below a newer expired one does not come back", () => {
    const live = item({ observedAt: ago(500), weight: 0.8 }); // expired (> 360)
    const older = item({ observedAt: ago(520), weight: 0.8 });
    expect(fuseState("presence_home", [live, older], NOW).value).toBeNull();
  });

  it("fuseState takes no source state: a silent classification cannot change its output", () => {
    const entry = { availability: availability() };
    const items = [item()];
    const before = fuseState("presence_home", items, NOW);
    expect(classifySource(entry, book({ lastLiveIngestAt: ago(9999) }), NOW)?.state).toBe("silent");
    expect(fuseState("presence_home", items, NOW)).toEqual(before);
  });

  it("is order independent", () => {
    const rand = rng(52);
    for (let t = 0; t < 50; t++) {
      const items = genItems(rand, { holds: true, refreshed: true });
      const shuffled = [...items].sort(() => rand() - 0.5);
      expect(fuseState("presence_home", shuffled, NOW)).toEqual(fuseState("presence_home", items, NOW));
    }
  });
});

/* -------------------------------------------------------------------- ledgers */

describe("fuseLedger worked examples", () => {
  const FROM = "2026-11-01T00:00:00.000Z";
  const TO = "2026-11-09T00:00:00.000Z"; // 8 days
  const day = (n: number) => new Date(Date.parse(FROM) + n * 86_400_000).toISOString();
  const claim = (over: Partial<CoverageClaim> & { from: string; to: string }): CoverageClaim => ({
    kind: "coverage",
    source: "tx",
    scope: "a1",
    key: `cov:${over.scope ?? "a1"}:${over.from}:${over.to}`,
    ingestedAt: day(8),
    tier: "periodic",
    ...over
  });
  const row = (over: Partial<LedgerRowRef> = {}): LedgerRowRef => ({ source: "tx", scope: "a1", at: day(3), ...over });
  const run = (over: Partial<Parameters<typeof fuseLedger>[0]> = {}) =>
    fuseLedger({ now: TO, window: { from: FROM, to: TO }, rows: [], claims: [], ...over });

  it("a subset row (a tap, a receipt) never forms a scope, so an unscoped one does not zero the family", () => {
    const base = { rows: [row()], claims: [claim({ from: day(0), to: day(8) })] };
    expect(run({ ...base, rows: [...base.rows, row({ scope: null, subset: true })] }).completeness).toBe(1);
    expect(run({ ...base, rows: [...base.rows, row({ scope: "zz", subset: true })] }).scopes).toHaveLength(1);
    // without the flag the unscoped row forms scope "_" with no coverage
    expect(run({ ...base, rows: [...base.rows, row({ scope: null })] }).completeness).toBe(0);
  });

  it("a non-finite window or now is an invalid-window result with completeness 0, never a throw", () => {
    for (const window of [
      { from: FROM, to: "Infinity" },
      { from: "-Infinity", to: TO },
      { from: FROM, to: "nonsense" }
    ]) {
      const r = run({
        window: { from: window.from, to: window.to },
        rows: [row()],
        claims: [claim({ from: day(0), to: day(8) })]
      });
      expect(r.completeness).toBe(0);
      expect(r.scopes).toEqual([]);
    }
    const inf = fuseLedger({ now: TO, window: { from: Infinity as unknown as string, to: TO }, rows: [], claims: [] });
    expect(inf.completeness).toBe(0);
    expect(inf.problem).toMatch(/Invalid window/);
    expect(run({ now: Number.NaN, rows: [row()] }).problem).toMatch(/Invalid window/);
    expect(run({ window: { from: TO, to: FROM } }).problem).toBeUndefined();
  });

  it("a claim is clipped to now: coverage promised for the future does not count", () => {
    const r = run({ now: day(4), rows: [row()], claims: [claim({ from: day(0), to: day(8) })] });
    expect(r.completeness).toBeCloseTo(0.5, 12);
    expect(r.scopes[0]!.gaps).toEqual([{ from: day(4), to: day(8) }]);
  });

  it("the share is the union of coverage over the window, with gaps listed", () => {
    const r = run({
      rows: [row()],
      claims: [claim({ from: day(0), to: day(4) }), claim({ from: day(2), to: day(6) })]
    });
    expect(r.completeness).toBeCloseTo(0.75, 12);
    expect(r.scopes[0]!.gaps).toEqual([{ from: day(6), to: day(8) }]);
    expect(r.trust).toBe("periodic");
  });

  it("completeness is the minimum over known scopes", () => {
    const r = run({
      rows: [row(), row({ scope: "a2" })],
      claims: [claim({ from: day(0), to: day(8) }), claim({ scope: "a2", from: day(0), to: day(2) })]
    });
    expect(r.scopes.map((s) => [s.scope, s.share])).toEqual([
      ["a1", 1],
      ["a2", 0.25]
    ]);
    expect(r.completeness).toBe(0.25);
  });

  it("a scope with rows but no coverage scores 0, so one failed account shows as partial", () => {
    const r = run({ rows: [row(), row({ scope: "a2" })], claims: [claim({ from: day(0), to: day(8) })] });
    expect(r.completeness).toBe(0);
    expect(r.scopes.find((s) => s.scope === "a2")).toMatchObject({ share: 0, trust: null });
    expect(r.scopes.find((s) => s.scope === "a2")!.gaps).toEqual([{ from: FROM, to: TO }]);
  });

  it("rows with no coverage anywhere give 0, not 'no spend'", () => {
    expect(run({ rows: [row()] }).completeness).toBe(0);
  });

  it("a scope outside 90 days of the window is not known", () => {
    const far = row({ scope: "old", at: new Date(Date.parse(FROM) - 91 * 86_400_000).toISOString() });
    const r = run({ rows: [row(), far], claims: [claim({ from: day(0), to: day(8) })] });
    expect(r.scopes.map((s) => s.scope)).toEqual(["a1"]);
    expect(r.completeness).toBe(1);
  });

  it("an import extent for a scope counts as coverage, with its own tier as trust", () => {
    const r = run({
      rows: [row()],
      claims: [
        claim({ from: day(0), to: day(4) }),
        { kind: "import", source: "tx", scope: "a1", from: day(4), to: day(8), ingestedAt: day(8), tier: "import" }
      ]
    });
    expect(r.completeness).toBe(1);
    expect(r.trust).toBe("import"); // the lowest tier covering
  });

  it("retention clips each interval to now - retentionDays, so a claim cannot outlive its rows", () => {
    const r = run({ rows: [row()], claims: [claim({ from: day(0), to: day(8) })], retentionDays: { tx: 4 } });
    expect(r.completeness).toBeCloseTo(0.5, 12); // only day(4)..day(8) survives
    expect(r.scopes[0]!.gaps).toEqual([{ from: FROM, to: day(4) }]);
    expect(
      run({ rows: [row()], claims: [claim({ from: day(0), to: day(8) })], retentionDays: { other: 1 } }).completeness
    ).toBe(1);
  });

  it("retired sources are excluded, so their scopes stop being known", () => {
    const rows = [row(), row({ source: "old", scope: "gone" })];
    const claims = [claim({ from: day(0), to: day(8) })];
    expect(run({ rows, claims }).completeness).toBe(0);
    const r = run({ rows, claims, retiredSources: ["old"] });
    expect(r.scopes.map((s) => s.scope)).toEqual(["a1"]);
    expect(r.completeness).toBe(1);
  });

  it("a correction ingested later retracts a coverage row; one ingested earlier does not", () => {
    const c = claim({ from: day(0), to: day(8), ingestedAt: day(5) });
    const later = run({
      rows: [row()],
      claims: [c],
      retractions: [{ source: "tx", corrects: c.key!, ingestedAt: day(6) }]
    });
    expect(later.completeness).toBe(0);
    expect(later.scopes.map((s) => s.scope)).toEqual(["a1"]); // still known: rows remain
    const earlier = run({
      rows: [row()],
      claims: [c],
      retractions: [{ source: "tx", corrects: c.key!, ingestedAt: day(4) }]
    });
    expect(earlier.completeness).toBe(1);
  });

  it("a retraction names a source: another source's key is untouched", () => {
    const c = claim({ from: day(0), to: day(8), ingestedAt: day(5) });
    const r = run({
      rows: [row()],
      claims: [c],
      retractions: [{ source: "other", corrects: c.key!, ingestedAt: day(6) }]
    });
    expect(r.completeness).toBe(1);
  });

  it("rev re-declares a retracted window: the new row is ingested after the correction", () => {
    const first = claim({ from: day(0), to: day(8), ingestedAt: day(5) });
    const redo = claim({ from: day(0), to: day(8), ingestedAt: day(7), key: `${first.key}:r2` });
    const r = run({
      rows: [row()],
      claims: [first, redo],
      retractions: [{ source: "tx", corrects: first.key!, ingestedAt: day(6) }]
    });
    expect(r.completeness).toBe(1);
    // Retracting the rev key later retracts it too.
    const r2 = run({
      rows: [row()],
      claims: [first, redo],
      retractions: [first, redo].map((x, i) => ({ source: "tx", corrects: x.key!, ingestedAt: day(7.5 + i) }))
    });
    expect(r2.completeness).toBe(0);
  });

  it("a scope absent from rows is known through its coverage row (claim alone)", () => {
    const r = run({ claims: [claim({ from: day(0), to: day(8) })] });
    expect(r.scopes.map((s) => s.scope)).toEqual(["a1"]);
    expect(r.completeness).toBe(1);
  });

  it("a family without a scope attribute uses one scope, _", () => {
    const r = run({ rows: [row({ scope: null })], claims: [claim({ scope: undefined, from: day(0), to: day(4) })] });
    expect(r.scopes.map((s) => s.scope)).toEqual(["_"]);
    expect(r.completeness).toBe(0.5);
  });

  it("clips to the window and ignores unreadable times, and an empty window gives 0", () => {
    const r = run({
      rows: [row()],
      claims: [claim({ from: day(-20), to: day(20) }), claim({ from: "bad", to: day(1) })]
    });
    expect(r.completeness).toBe(1);
    expect(fuseLedger({ now: TO, window: { from: TO, to: FROM }, rows: [row()], claims: [] }).completeness).toBe(0);
  });
});

describe("property P2L: ledgers", () => {
  const FROM = "2026-11-01T00:00:00.000Z";
  const TO = "2026-11-09T00:00:00.000Z";
  const base = Date.parse(FROM);
  const SRC = ["w", "x", "y", "z"];
  const SCOPES = ["a", "b", "c"];

  function gen(rand: () => number) {
    const rows: LedgerRowRef[] = [];
    const claims: CoverageClaim[] = [];
    const retractions: { source: string; corrects: string; ingestedAt: string }[] = [];
    for (let i = 0; i < 4 + Math.floor(rand() * 10); i++) {
      const source = SRC[Math.floor(rand() * SRC.length)]!;
      const scope = SCOPES[Math.floor(rand() * SCOPES.length)]!;
      if (rand() < 0.4) rows.push({ source, scope, at: new Date(base + rand() * 8 * 86_400_000).toISOString() });
      else {
        const a = base + (rand() * 9 - 1) * 86_400_000;
        const b = a + rand() * 5 * 86_400_000;
        const from = new Date(a).toISOString();
        const to = new Date(b).toISOString();
        const key = `cov:${scope}:${from}:${to}`;
        claims.push({
          kind: rand() < 0.2 ? "import" : "coverage",
          source,
          scope,
          key,
          from,
          to,
          ingestedAt: new Date(base + rand() * 5 * 86_400_000).toISOString(),
          tier: (["live", "periodic", "import", "inferred"] as const)[Math.floor(rand() * 4)]!
        });
        if (rand() < 0.2)
          retractions.push({
            source,
            corrects: key,
            ingestedAt: new Date(base + rand() * 8 * 86_400_000).toISOString()
          });
      }
    }
    return { rows, claims, retractions };
  }

  const run = (g: ReturnType<typeof gen>, retiredSources: string[] = [], retentionDays?: Record<string, number>) =>
    fuseLedger({ now: TO, window: { from: FROM, to: TO }, ...g, retiredSources, retentionDays });

  it("removing or retiring a route never raises the share of a remaining scope; completeness rises only when a scope drops out", () => {
    const rand = rng(61);
    for (let t = 0; t < TRIALS; t++) {
      const g = gen(rand);
      const retentionDays = rand() < 0.5 ? { w: 3, x: 6 } : undefined;
      const before = run(g, [], retentionDays);
      for (const source of SRC) {
        const removed = run(
          {
            rows: g.rows.filter((r) => r.source !== source),
            claims: g.claims.filter((c) => c.source !== source),
            retractions: g.retractions.filter((r) => r.source !== source)
          },
          [],
          retentionDays
        );
        const retired = run(g, [source], retentionDays);
        for (const after of [removed, retired]) {
          for (const s of after.scopes)
            expect(s.share).toBeLessThanOrEqual(
              (before.scopes.find((x) => x.scope === s.scope)?.share ?? Infinity) + EPS
            );
          if (after.completeness > before.completeness + EPS)
            expect(after.scopes.length).toBeLessThan(before.scopes.length);
          expect(after.scopes.every((s) => before.scopes.some((b) => b.scope === s.scope))).toBe(true);
        }
        expect(removed.completeness).toBeCloseTo(retired.completeness, 12);
      }
    }
  });

  it("a worked case: dropping the only failing account raises completeness, because the scope is no longer known", () => {
    const g = {
      rows: [
        { source: "x", scope: "a", at: new Date(base + 86_400_000).toISOString() },
        { source: "y", scope: "b", at: new Date(base + 86_400_000).toISOString() }
      ],
      claims: [
        {
          kind: "coverage" as const,
          source: "x",
          scope: "a",
          key: "k",
          from: FROM,
          to: TO,
          ingestedAt: FROM,
          tier: "live" as const
        }
      ],
      retractions: []
    };
    expect(run(g).completeness).toBe(0);
    expect(run(g, ["y"]).completeness).toBe(1);
  });

  it("P4 holds: a consumer weight is at most consumerWeight x completeness", () => {
    const rand = rng(62);
    for (let t = 0; t < 50; t++) {
      const r = run(gen(rand));
      const cw = rand();
      expect(scaleConsumerWeight(cw, r.completeness)).toBeLessThanOrEqual(cw * r.completeness + EPS);
    }
  });

  it("is order independent", () => {
    const rand = rng(63);
    for (let t = 0; t < 50; t++) {
      const g = gen(rand);
      const shuffled = {
        rows: [...g.rows].reverse(),
        claims: [...g.claims].reverse(),
        retractions: [...g.retractions].reverse()
      };
      expect(run(shuffled)).toEqual(run(g));
    }
  });
});
