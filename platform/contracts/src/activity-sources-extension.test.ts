import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_CORRECTION_KIND,
  ACTIVITY_SOURCES,
  KNOWN_ACTIVITY_FAMILIES,
  activityKindsOf,
  activitySourceEntry,
  activitySourceNames,
  describeExtensionSourceProblem,
  isKnownActivitySource
} from "./activity-events.js";
import { activityCoverageScopeRequired } from "./activity-batch.js";
import { registerContractsExtension, suspendContractsExtensions } from "./extensions.js";
import type { ActivitySourceEntry } from "./activity-events.js";

const availability = { delivery: "live", origin: "phone", feeds: [], recoveryHint: "Open the app." } as const;
const bare = (extra: Partial<ActivitySourceEntry> = {}): ActivitySourceEntry => {
  const { availability: _dropped, ...rest } = entry(extra);
  return rest;
};
const entry = (extra: Partial<ActivitySourceEntry> = {}): ActivitySourceEntry => ({
  schemaVersion: 1,
  kinds: ["ping"],
  family: "stub@1",
  availability,
  ...extra
});

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  (KNOWN_ACTIVITY_FAMILIES as Set<string>).delete("stub@1");
});
function register(id: string, sources: Record<string, ActivitySourceEntry>) {
  restore = suspendContractsExtensions();
  (KNOWN_ACTIVITY_FAMILIES as Set<string>).add("stub@1");
  registerContractsExtension({ id, activitySources: sources });
}

describe("extension activity sources", () => {
  it("are seen by the merged readers", () => {
    register("mine", { "mine-tracker2": entry() });
    expect(isKnownActivitySource("mine-tracker2")).toBe(true);
    expect(activityKindsOf("mine-tracker2")).toEqual(["ping", ACTIVITY_CORRECTION_KIND]);
    expect(activitySourceEntry("mine-tracker2")?.family).toBe("stub@1");
    expect(activitySourceNames()).toContain("mine-tracker2");
    expect(activitySourceNames()).toContain("gmail");
    expect(isKnownActivitySource("mine-other")).toBe(false);
  });

  it("change nothing when no extension adds a source", () => {
    expect(isKnownActivitySource("gmail")).toBe(true);
    expect(activityKindsOf("gmail")).toEqual(["message", ACTIVITY_CORRECTION_KIND]);
    expect(activityKindsOf("constructor")).toEqual([]);
  });

  it("throw when a source shadows a core name", () => {
    register("mine", { gmail: entry() });
    expect(() => isKnownActivitySource("gmail")).toThrow(/shadows a core source/);
  });

  it("throw without the id prefix or with an unknown family", () => {
    register("mine", { "other-x": entry() });
    expect(() => isKnownActivitySource("x")).toThrow(/start with "mine-"/);
    restore?.();
    register("mine2", { "mine2-x": entry({ family: "nope@1" }) });
    expect(() => isKnownActivitySource("x")).toThrow(/existing family/);
    expect(describeExtensionSourceProblem("m", { "m-x": { schemaVersion: 1, kinds: [] } })).toMatch(/existing family/);
  });
});

describe("optional source entry fields", () => {
  it("accepts projectionKinds on an extension source entry type", () => {
    const entry: import("./activity-events.js").ActivitySourceEntry = {
      schemaVersion: 1,
      kinds: ["a", "b"],
      projectionKinds: ["b"]
    };
    expect(entry.projectionKinds).toEqual(["b"]);
  });
});

describe("activityCoverageScopeRequired", () => {
  it("looks sources up in the merged core and extension registry", () => {
    register("mine", {
      "mine-chat": bare({ kinds: ["message"] }),
      "mine-reader": entry({ availability }),
      "mine-ledger": entry({
        availability: {
          ...availability,
          feeds: [{ signal: "spend", tier: "live", kinds: ["ping"], weight: 0.5, complete: true }]
        }
      }),
      "mine-plain": bare()
    });
    // An availability with no feeds needs a scope; a ledger feed or no availability does not.
    expect(activityCoverageScopeRequired("mine-reader")).toBe(true);
    expect(activityCoverageScopeRequired("mine-ledger")).toBe(false);
    expect(activityCoverageScopeRequired("mine-plain")).toBe(false);
    expect(activityCoverageScopeRequired("mine-chat")).toBe(false);
    // The core source with availability and no feeds needs one; a core source without availability does not.
    const core = Object.keys(ACTIVITY_SOURCES).find(
      (name) => ACTIVITY_SOURCES[name]!.availability?.feeds.length === 0
    )!;
    expect(activityCoverageScopeRequired(core)).toBe(true);
    expect(activityCoverageScopeRequired("rhen-watch")).toBe(false);
    expect(activityCoverageScopeRequired("nowhere")).toBe(false);
  });

  it("needs a scope for an extension source of the message family", () => {
    (KNOWN_ACTIVITY_FAMILIES as Set<string>).add("message@1");
    try {
      register("mine", { "mine-chat": bare({ family: "message@1" }) });
      expect(activityCoverageScopeRequired("mine-chat")).toBe(true);
    } finally {
      (KNOWN_ACTIVITY_FAMILIES as Set<string>).delete("message@1");
    }
  });
});
