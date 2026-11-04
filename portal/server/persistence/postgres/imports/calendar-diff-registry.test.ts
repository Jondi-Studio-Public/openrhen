import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarProfile } from "./calendar-profiles/calendar";
import { fixedBlocksProfileFor } from "./calendar-profiles/fixed-blocks";
import {
  assertDiffProfilesRegistered,
  diffProfileTraits,
  findProfile,
  profileFor,
  registerDiffProfile,
  registeredDiffProfile,
  registeredDiffProfileNames,
  unregisteredDiffProfiles
} from "./calendar-diff";

describe("the diff profile registry", () => {
  it("has the core profiles, registered before first use", () => {
    expect(registeredDiffProfileNames()).toEqual(expect.arrayContaining(["calendar", "fixed_blocks"]));
    expect(registeredDiffProfile("calendar", "google_calendar", "Google Calendar")).toBe(calendarProfile);
  });

  it("builds the profile per connection from the provider id and label", () => {
    const built = registeredDiffProfile("fixed_blocks", "school_term", "School term");
    expect(built?.provider).toBe("school_term");
    expect(built?.provider).toBe(fixedBlocksProfileFor("school_term", "School term").provider);
  });

  it("picks each connection's profile by the name its manifest declares and keeps stored provider ids", () => {
    expect(findProfile("google_calendar")).toBe(calendarProfile);
    expect(findProfile("nope")).toBeUndefined();
    expect(registeredDiffProfile("nope", "x", "X")).toBeUndefined();
    expect(() => profileFor("nope")).toThrow("No calendar diff profile is available for nope.");
  });

  it("carries the route traits with the profile", () => {
    expect(diffProfileTraits("fixed_blocks")).toEqual({});
    expect(diffProfileTraits("calendar")).toEqual({});
    expect(diffProfileTraits("nope")).toEqual({});
  });

  it("registers a new profile once and accepts the same registration again", () => {
    const factory = () => ({ ...calendarProfile, provider: "extra" });
    registerDiffProfile("extra_test_profile", factory);
    registerDiffProfile("extra_test_profile", factory);
    expect(registeredDiffProfile("extra_test_profile", "extra", "Extra")?.provider).toBe("extra");
  });

  it("refuses a different factory under a name already taken, a takeover of calendar and an empty name", () => {
    expect(() => registerDiffProfile("fixed_blocks", fixedBlocksProfileFor.bind(null))).toThrow("already registered");
    expect(() => registerDiffProfile("calendar", () => calendarProfile)).toThrow("already registered");
    expect(() => registerDiffProfile("", () => calendarProfile)).toThrow();
  });
});

describe("the registration check", () => {
  afterEach(() => {
    vi.doUnmock("@openrhen/contracts");
    vi.resetModules();
  });

  it("passes when every manifest's profile is registered", () => {
    expect(unregisteredDiffProfiles()).toEqual([]);
    expect(() => assertDiffProfilesRegistered()).not.toThrow();
  });

  it("throws, naming the connection and profile, when a manifest declares one nothing registered", async () => {
    vi.resetModules();
    vi.doMock("@openrhen/contracts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@openrhen/contracts")>();
      const google = actual.connectionManifest("google_calendar")!;
      const orphan = {
        ...google,
        id: "orphan_feed",
        calendarSource: { ...google.calendarSource!, diffProfile: "orphan_profile" }
      };
      return {
        ...actual,
        connectionRegistry: () => [...actual.connectionRegistry(), orphan],
        connectionManifest: (id: string) => (id === "orphan_feed" ? orphan : actual.connectionManifest(id))
      };
    });
    const diff = await import("./calendar-diff");
    expect(diff.unregisteredDiffProfiles()).toEqual([{ connectionId: "orphan_feed", profile: "orphan_profile" }]);
    expect(() => diff.assertDiffProfilesRegistered()).toThrow('orphan_feed declares "orphan_profile"');
    expect(() => diff.findProfile("orphan_feed")).toThrow("Diff profiles are not registered");
    expect(diff.findProfile("google_calendar")).toBeDefined();
  });
});
