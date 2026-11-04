import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { nextCurrentSituation, parseCurrentSituation, pruneStretch, situationAfterWake } from "./current-situation";

const situation = (extra: Partial<PortalState["currentSituation"]> = {}): PortalState["currentSituation"] => ({
  locationId: "home",
  locationSetAt: "2026-08-18T10:00:00.000Z",
  overrides: { printer: "unavailable" },
  carrying: { laptop: true },
  transportModes: ["car"],
  travel: {},
  travelOff: false,
  ...extra
});

describe("situationAfterWake", () => {
  it("re-asserts the last asserted location as of the wake and keeps everything else", () => {
    const wake = new Date("2026-08-18T21:00:00.000Z");
    const after = situationAfterWake(situation(), wake);
    expect(after).toEqual(situation({ locationSetAt: wake.toISOString() }));
  });

  it("only moves the assertion forward, so an older wake changes nothing", () => {
    const before = situation();
    expect(situationAfterWake(before, new Date("2026-08-18T09:00:00.000Z"))).toBe(before);
    expect(situationAfterWake(before, new Date("2026-08-18T10:00:00.000Z"))).toBe(before);
  });

  it("invents no location when none is asserted", () => {
    const before = situation({ locationId: null });
    expect(situationAfterWake(before, new Date("2026-08-18T21:00:00.000Z"))).toBe(before);
  });

  it("treats a location without a recorded assertion time as asserted before the wake", () => {
    const { locationSetAt: _unset, ...withoutSetAt } = situation();
    const wake = new Date("2026-08-18T21:00:00.000Z");
    expect(situationAfterWake(withoutSetAt, wake).locationSetAt).toBe(wake.toISOString());
  });
});

describe("parseCurrentSituation transport modes", () => {
  // Live data showed a stored `transportModes: []` on a situation with every place fully located and
  // home set, which silently disabled every travel leg (`situation-projection.ts`'s `!modes.length`
  // short circuit) even though nobody had ever deliberately turned travel off. Reading an absent key
  // already defaulted to every mode; a *stored* empty array must default the same way — "never
  // configured" and "explicitly emptied" are indistinguishable once persisted, so the read layer
  // resolves that ambiguity in favour of unconstrained, matching what a fresh row now stores by
  // default (`platform/database/src/schema.ts`).
  it("defaults to every mode when the key is entirely absent", () => {
    expect(parseCurrentSituation({ locationId: "home" }).transportModes).toEqual(["car", "bike", "walk"]);
  });

  it("defaults to every mode when the stored value is an empty array", () => {
    expect(parseCurrentSituation({ locationId: "home", transportModes: [] }).transportModes).toEqual([
      "car",
      "bike",
      "walk"
    ]);
  });

  it("keeps an explicit, non-empty stored subset exactly as stored", () => {
    expect(parseCurrentSituation({ locationId: "home", transportModes: ["car"] }).transportModes).toEqual(["car"]);
  });

  it("defaults an entirely missing stored value the same way", () => {
    expect(parseCurrentSituation(null).transportModes).toEqual(["car", "bike", "walk"]);
    expect(parseCurrentSituation(undefined).transportModes).toEqual(["car", "bike", "walk"]);
  });
});

describe("nextCurrentSituation transport modes", () => {
  it("persists an explicit empty selection on write, unlike a stored empty list on read", () => {
    const before = situation({ transportModes: ["car", "bike", "walk"] });
    // Unticking every box and saving must actually turn travel off — the read-time "empty means never
    // configured" default is for reconstructing an unconfigured record, not for overruling a deliberate
    // save. See `situation-projection.ts`'s `!modes.length` short circuit, which this keeps reachable.
    expect(nextCurrentSituation(before, { transportModes: [] }).transportModes).toEqual([]);
  });

  it("leaves transport modes alone when the save does not mention them", () => {
    const before = situation({ transportModes: ["car"] });
    expect(nextCurrentSituation(before, { locationId: "campus" }).transportModes).toEqual(["car"]);
  });
});

describe("the retired per-destination travel cache", () => {
  const measured = { minutes: 18, mode: "car" as const, refreshedAt: "2026-08-18T10:30:00.000Z" };

  it("parseCurrentSituation never reconstructs travel or travelRefreshedAt from storage", () => {
    const stored = { locationId: "home", travel: { campus: measured }, travelRefreshedAt: measured.refreshedAt };
    const parsed = parseCurrentSituation(stored);
    expect(parsed.travel).toEqual({});
    expect(parsed.travelRefreshedAt).toBeUndefined();
  });

  it("nextCurrentSituation never writes travel or travelRefreshedAt, on a location change or otherwise", () => {
    const before = situation({ travel: { campus: measured, shops: { ...measured, minutes: 7 } } });
    const movedAway = nextCurrentSituation(before, { locationId: "campus" });
    expect(movedAway.locationId).toBe("campus");
    expect(movedAway.overrides).toEqual({});
    expect(movedAway.travel).toEqual({});
    expect(movedAway.travelRefreshedAt).toBeUndefined();
    const namedTravel = nextCurrentSituation(before, { travel: { campus: measured } });
    expect(namedTravel.travel).toEqual({});
    expect(namedTravel.travelRefreshedAt).toBeUndefined();
  });
});

describe("underway (On my way)", () => {
  const underway = {
    commitmentId: "c1",
    occurrenceStartsAt: "2026-09-26T08:30:00.000Z",
    fromLocationId: "home",
    departedAt: "2026-09-26T07:56:00.000Z"
  };

  it("parseCurrentSituation reads a stored underway back", () => {
    const parsed = parseCurrentSituation({ locationId: "home", underway });
    expect(parsed.underway).toEqual(underway);
  });

  describe("with the clock fixed", () => {
    const now = new Date("2026-09-26T07:58:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
    });
    afterEach(() => vi.useRealTimers());

    it("an explicit underway in the save sets it, departedAt stamped by the server", () => {
      const before = situation({ underway: undefined });
      const after = nextCurrentSituation(before, { underway: { ...underway, departedAt: "2026-09-26T05:00:00.000Z" } });
      expect(after.underway).toEqual({ ...underway, departedAt: now.toISOString() });
    });

    it("a re-sent underway for the same trip keeps its stored departure (the CLI's whole-situation save)", () => {
      const before = situation({ underway });
      const after = nextCurrentSituation(before, { underway: { ...underway, departedAt: "2026-09-26T05:00:00.000Z" } });
      expect(after.underway).toEqual(underway);
    });

    it.each([
      ["commitmentId", "c2"],
      ["occurrenceStartsAt", "2026-09-27T08:30:00.000Z"],
      ["fromLocationId", "work"]
    ])("an underway with a different %s is a new trip, stamped now", (field, value) => {
      const before = situation({ underway });
      const after = nextCurrentSituation(before, { underway: { ...underway, [field]: value } });
      expect(after.underway).toEqual({ ...underway, [field]: value, departedAt: now.toISOString() });
    });
  });

  it("rejects an underway whose times are not ISO datetimes with an offset", () => {
    for (const bad of [
      { ...underway, departedAt: "x" },
      { ...underway, occurrenceStartsAt: "x" },
      { ...underway, departedAt: "2026-09-26T07:56:00" },
      { ...underway, commitmentId: "" },
      { ...underway, fromLocationId: "" }
    ]) {
      expect(parseCurrentSituation({ locationId: "home", underway: bad }).underway).toBeUndefined();
      const before = situation({ underway });
      expect(nextCurrentSituation(before, { underway: bad }).underway).toEqual(underway);
    }
  });

  it("a same-place refresh (re-asserting the origin) does not clear it", () => {
    const before = situation({ locationId: "home", underway });
    const after = nextCurrentSituation(before, { locationId: "home" });
    expect(after.underway).toEqual(underway);
  });

  it("asserting a different place clears it", () => {
    const before = situation({ locationId: "home", underway });
    const after = nextCurrentSituation(before, { locationId: "cafe" });
    expect(after.underway).toBeNull();
  });

  it("asserting the destination (arrival) clears it", () => {
    const before = situation({ locationId: "home", underway });
    const after = nextCurrentSituation(before, { locationId: "dentist" });
    expect(after.underway).toBeNull();
  });

  it("a save that names neither location nor underway leaves it untouched", () => {
    const before = situation({ locationId: "home", underway });
    const after = nextCurrentSituation(before, { transportModes: ["car"] });
    expect(after.underway).toEqual(underway);
  });

  it("an explicit underway: null clears it", () => {
    const before = situation({ locationId: "home", underway });
    const after = nextCurrentSituation(before, { underway: null });
    expect(after.underway).toBeNull();
  });
});

describe("energySetAt", () => {
  const said = "2026-08-18T08:00:00.000Z";

  it("parseCurrentSituation reads a stored date back, and drops one that is not a datetime", () => {
    expect(parseCurrentSituation({ locationId: "home", energySetAt: said }).energySetAt).toBe(said);
    expect(parseCurrentSituation({ locationId: "home", energySetAt: "yesterday" }).energySetAt).toBeUndefined();
    expect(parseCurrentSituation({ locationId: "home" })).not.toHaveProperty("energySetAt");
  });

  it("nextCurrentSituation keeps the stored date through any situation save", () => {
    const previous = situation({ energySetAt: said });
    expect(nextCurrentSituation(previous, { locationId: "work" }).energySetAt).toBe(said);
    expect(nextCurrentSituation(previous, { carrying: { laptop: false } }).energySetAt).toBe(said);
    expect(nextCurrentSituation(previous, undefined).energySetAt).toBe(said);
  });

  it("nextCurrentSituation takes no date from the payload, so a resent situation cannot move it", () => {
    const resent = { locationId: "home", energySetAt: "2026-08-18T23:59:00.000Z" };
    expect(nextCurrentSituation(situation({ energySetAt: said }), resent).energySetAt).toBe(said);
    expect(nextCurrentSituation(situation(), resent)).not.toHaveProperty("energySetAt");
  });

  it("situationAfterWake leaves it alone", () => {
    const after = situationAfterWake(situation({ energySetAt: said }), new Date("2026-08-18T21:00:00.000Z"));
    expect(after.energySetAt).toBe(said);
  });
});

describe("stretch", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    actionId: "a1",
    title: "Unit 3",
    acceptedAt: "2026-08-18T10:00:00.000Z",
    until: "2026-08-18T10:40:00.000Z",
    minutes: 40,
    by: "person",
    ...over
  });
  const now = new Date("2026-08-18T12:00:00.000Z");
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("reads an old row without the key exactly as before", () => {
    expect(parseCurrentSituation({ locationId: "home" })).not.toHaveProperty("stretch");
    expect(parseCurrentSituation({ locationId: "home", stretch: {} })).not.toHaveProperty("stretch");
    expect(parseCurrentSituation({ locationId: "home", stretch: "x" })).not.toHaveProperty("stretch");
  });

  it("parses a valid state and drops bad entries one by one", () => {
    const parsed = parseCurrentSituation({
      locationId: "home",
      stretch: {
        accepted: [record(), record({ until: "later" }), record({ minutes: 0 }), "junk"],
        declined: [
          { actionId: "a2", at: "2026-08-18T09:00:00.000Z" },
          { actionId: "", at: "x" }
        ],
        declinedAllAt: "not a date"
      }
    });
    expect(parsed.stretch).toEqual({
      accepted: [record()],
      declined: [{ actionId: "a2", at: "2026-08-18T09:00:00.000Z" }]
    });
  });

  it("carries the stored stretch and ignores a client-supplied one, even in a whole situation resent", () => {
    const stored = { accepted: [record()] as never, declined: [] };
    const previous = situation({ stretch: stored });
    const forged = { accepted: [record({ actionId: "forged" })], declined: [] };
    expect(nextCurrentSituation(previous, { locationId: "work" }).stretch).toEqual(stored);
    expect(nextCurrentSituation(previous, { ...previous, stretch: forged }).stretch).toEqual(stored);
    expect(nextCurrentSituation(situation(), { stretch: forged })).not.toHaveProperty("stretch");
    expect(nextCurrentSituation(previous, undefined).stretch).toEqual(stored);
  });

  it("prunes at the 7 day and 2 day boundaries", () => {
    const state = {
      accepted: [
        record({ actionId: "keep", until: ago(7 * DAY) }),
        record({ actionId: "drop", until: ago(7 * DAY + 1) })
      ],
      declined: [
        { actionId: "keep", at: ago(2 * DAY) },
        { actionId: "drop", at: ago(2 * DAY + 1) }
      ],
      declinedAllAt: ago(2 * DAY + 1)
    } as never;
    const pruned = pruneStretch(state, now)!;
    expect(pruned.accepted.map((entry) => entry.actionId)).toEqual(["keep"]);
    expect(pruned.declined.map((entry) => entry.actionId)).toEqual(["keep"]);
    expect(pruned.declinedAllAt).toBeUndefined();
    expect(pruneStretch({ accepted: [], declined: [], declinedAllAt: ago(2 * DAY) }, now)?.declinedAllAt).toBe(
      ago(2 * DAY)
    );
  });

  it("returns undefined when nothing is left and caps oldest first", () => {
    expect(pruneStretch(undefined, now)).toBeUndefined();
    expect(pruneStretch({ accepted: [record({ until: ago(30 * DAY) })] as never, declined: [] }, now)).toBeUndefined();
    const many = Array.from({ length: 35 }, (_, i) =>
      record({
        actionId: `a${i}`,
        acceptedAt: new Date(now.getTime() - (40 - i) * 60_000).toISOString(),
        until: ago(0)
      })
    );
    const pruned = pruneStretch({ accepted: many as never, declined: [] }, now)!;
    expect(pruned.accepted).toHaveLength(30);
    expect(pruned.accepted[0]!.actionId).toBe("a5");
    const declines = Array.from({ length: 60 }, (_, i) => ({
      actionId: `d${i}`,
      at: new Date(now.getTime() - (60 - i) * 60_000).toISOString()
    }));
    const prunedDeclines = pruneStretch({ accepted: [], declined: declines }, now)!;
    expect(prunedDeclines.declined).toHaveLength(50);
    expect(prunedDeclines.declined[0]!.actionId).toBe("d10");
  });
});

describe("parseCurrentSituation stretch caps", () => {
  it("keeps the newest 30 accepted and 50 declined entries, matching the engine wire schema", () => {
    const at = "2026-08-18T12:00:00.000Z";
    const accepted = Array.from({ length: 35 }, (_, i) => ({
      actionId: `a${i}`,
      title: `A${i}`,
      acceptedAt: at,
      until: at,
      minutes: 30,
      by: "person"
    }));
    const declined = Array.from({ length: 55 }, (_, i) => ({ actionId: `d${i}`, at }));
    const parsed = parseCurrentSituation({ stretch: { accepted, declined } }).stretch!;
    expect(parsed.accepted).toHaveLength(30);
    expect(parsed.accepted[0]!.actionId).toBe("a5");
    expect(parsed.declined).toHaveLength(50);
    expect(parsed.declined[0]!.actionId).toBe("d5");
  });
});
