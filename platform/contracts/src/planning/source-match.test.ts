import { describe, expect, it } from "vitest";
import { EXAMPLE_DAILY_SOURCE, EXAMPLE_INTERVAL_SOURCE } from "../connections/example-sources.js";
import {
  aliasTitleNorm,
  carriesPublishMarker,
  matchCommitment,
  matchHandEntry,
  matchSeriesToRule,
  sourceRole,
  type SourceAlias,
  type SourceCandidate,
  type SourceCommitment,
  type SourceRule
} from "./source-match.js";

function commitment(overrides: Partial<SourceCommitment> = {}): SourceCommitment {
  return {
    id: "c1",
    title: "Harbor Mart shift",
    startsAt: "2026-09-30T09:00:00.000Z",
    endsAt: "2026-09-30T17:00:00.000Z",
    allDay: false,
    localDate: "2026-09-30",
    status: "scheduled",
    links: [],
    ...overrides
  };
}

function candidate(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    provider: "example_shared",
    externalId: "sk1",
    title: "Harbor Mart shift",
    startsAt: "2026-09-30T09:00:00.000Z",
    endsAt: "2026-09-30T17:00:00.000Z",
    allDay: false,
    localDate: "2026-09-30",
    description: null,
    ...overrides
  };
}

describe("matchCommitment", () => {
  it("is strong for equal times and similar titles", () => {
    const result = matchCommitment(candidate({ title: "Harbor Mart shift 0900" }), [commitment()], []);
    expect(result).toMatchObject({ kind: "strong", commitmentId: "c1" });
  });

  it("tolerates ten minutes on each end, not eleven", () => {
    const near = candidate({ startsAt: "2026-09-30T09:10:00.000Z", endsAt: "2026-09-30T16:50:00.000Z" });
    expect(matchCommitment(near, [commitment()], []).kind).toBe("strong");
    const far = candidate({ startsAt: "2026-09-30T09:11:00.000Z" });
    expect(matchCommitment(far, [commitment()], []).kind).toBe("possible");
  });

  it("compares start only when an end is missing", () => {
    expect(matchCommitment(candidate({ endsAt: null }), [commitment()], []).kind).toBe("strong");
  });

  it("is possible for equal times and unrelated titles", () => {
    const result = matchCommitment(candidate({ title: "Jon work" }), [commitment()], []);
    expect(result).toMatchObject({ kind: "possible", commitmentId: "c1" });
  });

  it("is possible for the same title moved on the same day", () => {
    const moved = candidate({ startsAt: "2026-09-30T13:00:00.000Z", endsAt: "2026-09-30T14:00:00.000Z" });
    expect(matchCommitment(moved, [commitment({ endsAt: "2026-09-30T10:00:00.000Z" })], []).kind).toBe("possible");
  });

  it("is possible for a matching title overlapping at least half the shorter event across days", () => {
    const night = commitment({
      startsAt: "2026-09-30T20:00:00.000Z",
      endsAt: "2026-10-01T04:00:00.000Z",
      localDate: "2026-09-30"
    });
    const overlapping = candidate({
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-10-01T06:00:00.000Z",
      localDate: "2026-10-01"
    });
    expect(matchCommitment(overlapping, [night], []).kind).toBe("possible");
    const barely = candidate({
      startsAt: "2026-10-01T03:00:00.000Z",
      endsAt: "2026-10-01T09:00:00.000Z",
      localDate: "2026-10-01"
    });
    expect(matchCommitment(barely, [night], []).kind).toBe("none");
  });

  it("is none for a different title at a different time", () => {
    const other = candidate({ title: "Dentist", startsAt: "2026-09-30T18:00:00.000Z", endsAt: null });
    expect(matchCommitment(other, [commitment()], []).kind).toBe("none");
  });

  it("compares all-day events by date and title only", () => {
    const day = commitment({ title: "Holiday", allDay: true, startsAt: "2026-09-30T00:00:00.000Z", endsAt: null });
    expect(matchCommitment(candidate({ title: "Holiday", allDay: true }), [day], []).kind).toBe("strong");
    expect(
      matchCommitment(candidate({ title: "Holiday", allDay: true, localDate: "2026-10-01" }), [day], []).kind
    ).toBe("none");
    expect(matchCommitment(candidate({ title: "Sports carnival", allDay: true }), [day], []).kind).toBe("none");
    // Either side all-day is enough, so a timed event does not fall back to time comparison.
    expect(matchCommitment(candidate({ title: "Holiday" }), [day], []).kind).toBe("strong");
  });

  it("never matches a cancelled commitment", () => {
    expect(matchCommitment(candidate(), [commitment({ status: "cancelled" })], []).kind).toBe("none");
  });

  it("upgrades a possible match to strong through an alias for the same provider only", () => {
    const remote = candidate({ title: "Jon work" });
    const alias: SourceAlias = {
      provider: "example_shared",
      remoteTitleNorm: aliasTitleNorm("Jon work"),
      localTitleNorm: aliasTitleNorm("Harbor Mart shift")
    };
    expect(matchCommitment(remote, [commitment()], []).kind).toBe("possible");
    expect(matchCommitment(remote, [commitment()], [alias]).kind).toBe("strong");
    expect(matchCommitment({ ...remote, provider: "google_calendar" }, [commitment()], [alias]).kind).toBe("possible");
  });

  it("is exact when the description carries the OpenRhen marker", () => {
    const marked = candidate({
      title: "Unrelated",
      startsAt: "2026-10-05T01:00:00.000Z",
      description: "OpenRhen:c2"
    });
    const result = matchCommitment(marked, [commitment(), commitment({ id: "c2" })], []);
    expect(result).toMatchObject({ kind: "exact", commitmentId: "c2" });
  });

  it("is exact when the external id is already linked, and beats a strong match elsewhere", () => {
    const linked = commitment({
      id: "c2",
      title: "Other",
      links: [{ provider: "example_shared", externalId: "sk1" }]
    });
    expect(matchCommitment(candidate(), [commitment(), linked], [])).toMatchObject({
      kind: "exact",
      commitmentId: "c2"
    });
    // Same external id under a different provider is not a link.
    expect(matchCommitment(candidate({ provider: "google_calendar" }), [linked], []).kind).not.toBe("exact");
  });
});

describe("sourceRole", () => {
  it("makes only a source whose manifest says primary primary", () => {
    expect(sourceRole(EXAMPLE_DAILY_SOURCE)).toBe("primary");
    for (const provider of [EXAMPLE_INTERVAL_SOURCE, "google_calendar", "apple_calendar", "email"] as const) {
      expect(sourceRole(provider)).toBe("secondary");
    }
    expect(sourceRole("some_new_source")).toBe("secondary");
  });
});

describe("carriesPublishMarker", () => {
  it("recognises the publish marker and nothing else", () => {
    expect(carriesPublishMarker("OpenRhen:3f2b8c1e-0d4a-4b6f-9e2a-1c5d7e9f0a1b")).toBe(true);
    expect(carriesPublishMarker("Pick up from OpenRhen:soon")).toBe(false);
    expect(carriesPublishMarker(null)).toBe(false);
  });
});

describe("matchHandEntry", () => {
  const entry = {
    title: "Harbor Mart shift",
    startsAt: "2026-09-30T09:00:00.000Z",
    endsAt: "2026-09-30T17:00:00.000Z",
    localDate: "2026-09-30"
  };

  it("is strong for the same times and a matching title", () => {
    expect(matchHandEntry(entry, [commitment()])).toMatchObject({ kind: "strong", commitmentId: "c1" });
  });

  it("is possible for the same times under an unrelated title", () => {
    expect(matchHandEntry({ ...entry, title: "Dentist" }, [commitment()])).toMatchObject({
      kind: "possible",
      commitmentId: "c1"
    });
  });

  it("is possible for a matching title at another time on the same day", () => {
    const later = { ...entry, startsAt: "2026-09-30T12:00:00.000Z", endsAt: "2026-09-30T13:00:00.000Z" };
    expect(matchHandEntry(later, [commitment()]).kind).toBe("possible");
  });

  it("is none for another day, and never counts a cancelled commitment", () => {
    const tomorrow = {
      ...entry,
      startsAt: "2026-10-01T09:00:00.000Z",
      endsAt: "2026-10-01T17:00:00.000Z",
      localDate: "2026-10-01"
    };
    expect(matchHandEntry(tomorrow, [commitment()]).kind).toBe("none");
    expect(matchHandEntry(entry, [commitment({ status: "cancelled" })]).kind).toBe("none");
  });

  it("is never exact and ignores links", () => {
    const linked = commitment({ links: [{ provider: "email", externalId: "hand-entry" }] });
    expect(matchHandEntry(entry, [linked]).kind).toBe("strong");
  });
});

describe("matchSeriesToRule", () => {
  const days = ["2026-09-01", "2026-09-08", "2026-09-15"];
  const series = days.map((day, index) =>
    candidate({
      externalId: `college-${index}`,
      title: "College",
      startsAt: `${day}T00:30:00.000Z`,
      endsAt: `${day}T06:30:00.000Z`,
      localDate: day
    })
  );
  const rule = (overrides: Partial<SourceRule> = {}): SourceRule => ({
    id: "r1",
    title: "College class",
    version: 2,
    linkedProviders: [],
    occurrences: days.map((day) =>
      commitment({
        id: `r1-${day}`,
        title: "College class",
        startsAt: `${day}T00:30:00.000Z`,
        endsAt: `${day}T06:30:00.000Z`,
        localDate: day
      })
    ),
    ...overrides
  });

  it("links a series whose every occurrence is a Strong match for one rule", () => {
    expect(matchSeriesToRule(series, [rule()], [])).toMatchObject({ ruleId: "r1" });
  });

  it("does not link when one occurrence has no rule occurrence that day, or only a Possible one", () => {
    const short = rule({ occurrences: rule().occurrences.slice(0, 2) });
    expect(matchSeriesToRule(series, [short], [])).toBeNull();
    const moved = rule({
      occurrences: rule().occurrences.map((item, index) =>
        index === 2 ? { ...item, startsAt: "2026-09-15T03:00:00.000Z", endsAt: "2026-09-15T08:00:00.000Z" } : item
      )
    });
    expect(matchSeriesToRule(series, [moved], [])).toBeNull();
  });

  it("uses a remembered alias for a series titled differently", () => {
    const renamed = series.map((item) => ({ ...item, title: "Jon study" }));
    expect(matchSeriesToRule(renamed, [rule()], [])).toBeNull();
    const alias: SourceAlias = {
      provider: "example_shared",
      remoteTitleNorm: aliasTitleNorm("Jon study"),
      localTitleNorm: aliasTitleNorm("College class")
    };
    expect(matchSeriesToRule(renamed, [rule()], [alias])).toMatchObject({ ruleId: "r1" });
  });

  it("refuses when two rules agree, when the provider already links the rule, or for a single occurrence", () => {
    expect(matchSeriesToRule(series, [rule(), rule({ id: "r2" })], [])).toBeNull();
    expect(matchSeriesToRule(series, [rule({ linkedProviders: ["example_shared"] })], [])).toBeNull();
    expect(matchSeriesToRule(series.slice(0, 1), [rule()], [])).toBeNull();
  });
});
