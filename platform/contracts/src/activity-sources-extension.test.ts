import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_CORRECTION_KIND,
  KNOWN_ACTIVITY_FAMILIES,
  activityKindsOf,
  activitySourceEntry,
  activitySourceNames,
  describeExtensionSourceProblem,
  isKnownActivitySource
} from "./activity-events.js";
import { registerContractsExtension, suspendContractsExtensions } from "./extensions.js";
import type { ActivitySourceEntry } from "./activity-events.js";

const availability = { delivery: "live", origin: "phone", feeds: [], recoveryHint: "Open the app." } as const;
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
