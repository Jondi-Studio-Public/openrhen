import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import {
  commitmentFields,
  declinedDeleteDismissals,
  declinedDeleteId,
  importField,
  isDeleteDeclined,
  linkCalendarEventCommitment,
  locationField,
  matchLocation,
  withinRange,
  type LocationRow
} from "./calendar-diff-core";
import type { Sql } from "../sql-pool";

const places: LocationRow[] = [
  { id: "b", name: "Royal Infirmary" },
  { id: "a", name: "Infirmary" },
  { id: "c", name: "Dental Clinic" }
];

describe("matchLocation", () => {
  it("takes an exact name as said, at high confidence and without review", () => {
    const match = matchLocation("dental clinic", places);
    expect(match).toMatchObject({ confidence: "high", needsReview: false });
    expect(match?.location.id).toBe("c");
  });

  it("reads a name inside the text at medium, a near-spelling at low, both flagged for review", () => {
    expect(matchLocation("Visit at the Dental Clinic, Ward 3", places)).toMatchObject({
      confidence: "medium",
      needsReview: true
    });
    expect(matchLocation("Dental Clinik", places)).toMatchObject({ confidence: "low", needsReview: true });
  });

  it("settles a tie on the longest name, and returns nothing when no place resembles the text", () => {
    expect(matchLocation("Royal Infirmary Ward 2", places)?.location.id).toBe("b");
    expect(matchLocation("Somewhere else", places)).toBeUndefined();
    expect(matchLocation("  ", places)).toBeUndefined();
  });

  it("turns a match into a place field, or a blank one", () => {
    expect(locationField(matchLocation("Dental Clinic", places))).toMatchObject({ value: "c", basis: "inferred" });
    expect(locationField(undefined)).toMatchObject({ value: null, basis: "missing" });
  });
});

describe("shared field helpers", () => {
  it("builds an explicit field, or a missing one for null and undefined", () => {
    expect(importField("x", ["e"])).toMatchObject({ value: "x", basis: "explicit", confidence: "high" });
    expect(importField(undefined, ["e"])).toMatchObject({ value: null, basis: "missing" });
  });

  it("diffs over the seven commitment fields", () => {
    expect(commitmentFields).toHaveLength(7);
  });

  it("keeps a start inside the window by its calendar day", () => {
    expect(withinRange("2026-10-10T23:00:00.000Z", "2026-10-10", "2026-10-10")).toBe(true);
    expect(withinRange("2026-10-11T00:00:00.000Z", "2026-10-10", "2026-10-10")).toBe(false);
  });
});

describe("declined deletes", () => {
  const record = (overrides: Record<string, unknown> = {}) =>
    ({
      importKey: "example_shared:event:e1",
      operation: "delete",
      removed: true,
      relationships: {},
      fields: {
        title: importField("Class", []),
        startsAt: importField("2026-10-10T09:00:00.000Z", [])
      },
      ...overrides
    }) as never;

  it("remembers a declined delete under its own dismissal id", () => {
    expect(declinedDeleteDismissals([record()], "example_shared:event:", "deselected")).toEqual([
      { externalEventId: "delete:e1", title: "Class", startsAt: "2026-10-10T09:00:00.000Z" }
    ]);
  });

  it("skips a delete held for a OpenRhen edit, another prefix, or (on commit) a kept row", () => {
    expect(
      declinedDeleteDismissals(
        [record({ relationships: { remoteCancelEdited: "title" } })],
        "example_shared:event:",
        "all"
      )
    ).toEqual([]);
    expect(declinedDeleteDismissals([record()], "google_calendar:event:", "all")).toEqual([]);
    expect(declinedDeleteDismissals([record({ removed: false })], "example_shared:event:", "deselected")).toEqual([]);
  });

  it("stops asking only while the link still describes the same event", () => {
    const dismissals = new Map([
      [
        declinedDeleteId("e1"),
        { external_event_id: "delete:e1", title: "Class", starts_at: new Date("2026-10-10T09:00:00.000Z") }
      ]
    ]);
    expect(isDeleteDeclined("e1", { title: "Class", startsAt: "2026-10-10T09:00:00Z" }, dismissals)).toBe(true);
    expect(isDeleteDeclined("e1", { title: "Moved", startsAt: "2026-10-10T09:00:00Z" }, dismissals)).toBe(false);
    expect(isDeleteDeclined("e2", { title: "Class", startsAt: "2026-10-10T09:00:00Z" }, dismissals)).toBe(false);
  });
});

describe("linkCalendarEventCommitment", () => {
  function fakeSql() {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?"), values });
        return [{ id: "source-1" }];
      },
      { json: (value: unknown) => ({ json: value }) }
    );
    return { sql: sql as unknown as Sql, calls };
  }
  const args = {
    commitmentId: "c1",
    provider: "google_calendar",
    role: "secondary" as const,
    sourceType: "google_calendar_event",
    sourceExternalId: "key-1",
    linkExternalId: "event-1",
    frameId: "cal",
    profileLabel: "Work",
    sourceCalendarId: "cal",
    capturedText: "{}",
    snapshot: { title: "T" },
    hash: "h",
    title: "T",
    occurredAt: new Date("2026-10-10T09:00:00.000Z")
  };

  it("writes the source, points the commitment at it, then upserts the link under the link's own id", async () => {
    const { sql, calls } = fakeSql();
    await linkCalendarEventCommitment(sql, "u1", args);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.values).toContain("key-1");
    expect(calls[1]!.text).toContain("UPDATE commitments SET source_id=?");
    expect(calls[1]!.text).not.toContain("COALESCE");
    expect(calls[2]!.values).toContain("event-1");
    expect(calls[2]!.values).toContain("secondary");
  });

  it("keeps a joined commitment's first source", async () => {
    const { sql, calls } = fakeSql();
    await linkCalendarEventCommitment(sql, "u1", args, true);
    expect(calls[1]!.text).toContain("COALESCE(source_id");
  });
});
