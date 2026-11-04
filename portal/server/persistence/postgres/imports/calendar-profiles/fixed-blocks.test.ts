import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@openrhen/contracts";

const primaries = new Set<string>();
vi.mock("@/server/persistence/postgres/imports/primary-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/persistence/postgres/imports/primary-source")>();
  return { ...actual, isPrimarySource: (provider: string) => primaries.has(provider) };
});

const { calendarDiffRecords, registeredDiffProfile, registerDiffProfile } =
  await import("@/server/persistence/postgres/imports/calendar-diff");
const { fixedBlocksProfileFor, readFixedBlocks } = await import("./fixed-blocks");
type Input = import("@/server/persistence/postgres/imports/calendar-diff").CalendarDiffInput;
type Link = import("@/server/persistence/postgres/imports/calendar-diff").CalendarLinkRow;

const PROVIDER = "rota_feed";
const secondary = () => fixedBlocksProfileFor(PROVIDER, "Rota");

const block = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  externalEventId: "b1",
  calendarId: null,
  title: "Shift",
  description: null,
  startsAt: "2026-08-04T00:30:00.000Z",
  endsAt: "2026-08-04T05:30:00.000Z",
  allDay: false,
  timezone: "Australia/Adelaide",
  location: "Depot",
  status: "confirmed",
  seriesId: null,
  recurring: false,
  updatedAt: null,
  profileLabel: null,
  attributes: {},
  ...overrides
});

const input = (overrides: Partial<Input> = {}): Input => ({
  timezone: "Australia/Adelaide",
  timeMin: "2026-08-01T00:00:00.000Z",
  timeMax: "2026-09-01T00:00:00.000Z",
  events: [],
  calendarNames: {},
  links: [],
  importedSeriesKeys: new Set(),
  dismissals: [],
  locations: [],
  presetSteps: [],
  presetDependencies: [],
  ...overrides
});

const linkOf = (event: CalendarEvent): Link => {
  const profile = secondary();
  return {
    id: `link-${event.externalEventId}`,
    frame_id: "",
    external_event_id: event.externalEventId,
    commitment_id: `c-${event.externalEventId}`,
    version: 1,
    last_remote_snapshot: profile.storedSnapshot(event),
    title: event.title,
    starts_at: new Date(event.startsAt),
    ends_at: new Date(event.endsAt),
    status: "confirmed",
    location: event.location,
    setup_before_minutes: 0,
    transition_after_minutes: 0
  };
};

beforeEach(() => primaries.clear());

describe("the fixed_blocks profile", () => {
  it("is registered from core, idempotently, under the name a manifest declares", () => {
    expect(registeredDiffProfile("fixed_blocks", PROVIDER, "Rota")?.provider).toBe(PROVIDER);
    registerDiffProfile("fixed_blocks", fixedBlocksProfileFor);
    expect(() => registerDiffProfile("fixed_blocks", () => secondary())).toThrow("already registered");
  });

  it("creates a block under the provider's own key, the feed's external id unhashed", () => {
    const records = calendarDiffRecords(input({ events: [block()] }), secondary());
    expect(records.map((r) => [r.operation, r.importKey])).toEqual([["create", `${PROVIDER}:event:b1`]]);
    expect(records[0]?.fields.title?.value).toBe("Shift");
    expect(records[0]?.fields.location?.value).toBe("Depot");
  });

  it("writes nothing for an unchanged linked block, and an update when it moved", () => {
    const profile = secondary();
    const same = calendarDiffRecords(input({ events: [block()], links: [linkOf(block())], only: "updates" }), profile);
    expect(same).toEqual([]);
    const moved = block({ startsAt: "2026-08-04T01:30:00.000Z" });
    const records = calendarDiffRecords(input({ events: [moved], links: [linkOf(block())], only: "updates" }), profile);
    expect(records.map((r) => r.operation)).toEqual(["update"]);
    expect(records[0]?.fields.startsAt?.value).toBe("2026-08-04T01:30:00.000Z");
  });

  it("lists a cancelled block for removal whether or not the read was complete", () => {
    for (const complete of [false, true, undefined]) {
      const records = calendarDiffRecords(
        input({ events: [block({ status: "cancelled" })], links: [linkOf(block())], only: "updates", complete }),
        secondary()
      );
      expect(records.map((r) => [r.operation, r.relationships.remoteCancelled])).toEqual([["delete", "true"]]);
    }
  });

  it("never deletes on absence unless the read declares itself complete", () => {
    const links = [linkOf(block())];
    for (const complete of [false, undefined])
      expect(calendarDiffRecords(input({ links, only: "updates", complete }), secondary())).toEqual([]);
    const records = calendarDiffRecords(input({ links, only: "updates", complete: true }), secondary());
    expect(records.map((r) => r.operation)).toEqual(["delete"]);
    expect(records[0]?.relationships.remoteCancelled).toBeUndefined();
  });

  it("keeps a complete read from deleting a block outside the window", () => {
    const later = block({ startsAt: "2026-12-04T00:30:00.000Z", endsAt: "2026-12-04T05:30:00.000Z" });
    expect(
      calendarDiffRecords(input({ links: [linkOf(later)], only: "updates", complete: true }), secondary())
    ).toEqual([]);
  });

  it("does not collapse blocks that share a title: each id is its own create, and its own link", () => {
    const a = block({ externalEventId: "a" });
    const b = block({ externalEventId: "b", startsAt: "2026-08-05T00:30:00.000Z", endsAt: "2026-08-05T05:30:00.000Z" });
    const c = block({ externalEventId: "c", location: "Other depot" });
    const created = calendarDiffRecords(input({ events: [a, b, c] }), secondary());
    expect(created.map((r) => r.importKey)).toEqual([
      `${PROVIDER}:event:a`,
      `${PROVIDER}:event:b`,
      `${PROVIDER}:event:c`
    ]);
    // One of three moves: only that link updates.
    const moved = calendarDiffRecords(
      input({ events: [a, { ...b, location: "Moved" }, c], links: [linkOf(a), linkOf(b), linkOf(c)], only: "updates" }),
      secondary()
    );
    expect(moved.map((r) => r.importKey)).toEqual([`${PROVIDER}:event:b`]);
  });

  it("joins a commitment already on the plan by time and title, not by title alone", () => {
    const commitment = {
      id: "c1",
      title: "Shift",
      startsAt: "2026-08-04T00:30:00.000Z",
      endsAt: "2026-08-04T05:30:00.000Z",
      links: [],
      location: "Depot"
    };
    const context = { commitments: [commitment as never], aliases: [] };
    const same = calendarDiffRecords(input({ events: [block()], matchContext: context }), secondary());
    expect(same[0]?.operation).not.toBe("create");
    const elsewhere = block({
      externalEventId: "b2",
      startsAt: "2026-08-06T00:30:00.000Z",
      endsAt: "2026-08-06T05:30:00.000Z"
    });
    expect(calendarDiffRecords(input({ events: [elsewhere], matchContext: context }), secondary())[0]?.operation).toBe(
      "create"
    );
  });

  it("as a primary, applies its own fields when it joins a commitment and is never held back by another source", () => {
    primaries.add(PROVIDER);
    const primary = fixedBlocksProfileFor(PROVIDER, "Rota");
    expect(primary.matchApplyFields).toEqual(["title", "startsAt", "endsAt", "location"]);
    expect(primary.ownedFields([{ id: "x", provider: "google_calendar" as never, externalEventId: "g" }])).toBeNull();
    expect(primary.dismissals).toBeUndefined();
    expect(primary.allDayStartsUnselected).toBe(false);
  });

  it("as a secondary, defers to a primary source on the fields it owns and remembers what was declined", () => {
    const profile = secondary();
    expect(profile.matchApplyFields).toBeUndefined();
    expect(profile.ownedFields([{ id: "x", provider: "google_calendar" as never, externalEventId: "g" }])).toBeNull();
    primaries.add("other_roster");
    expect(profile.ownedFields([{ id: "x", provider: "other_roster" as never, externalEventId: "r" }])).toMatchObject({
      fields: ["title", "startsAt", "endsAt", "location"]
    });
    expect(profile.dismissals).toBeDefined();
    const declined = {
      external_event_id: "b1",
      title: "Shift",
      starts_at: new Date("2026-08-04T00:30:00.000Z")
    };
    expect(calendarDiffRecords(input({ events: [block()], dismissals: [declined] }), profile)).toEqual([]);
  });

  it("never proposes back an event OpenRhen itself published", () => {
    expect(calendarDiffRecords(input({ events: [block({ description: "OpenRhen:abc123" })] }), secondary())).toEqual(
      []
    );
  });
});

describe("echo and skipped events", () => {
  it("never proposes back an event whose id OpenRhen published, even with the description stripped", () => {
    const published = new Set(["b1"]);
    expect(calendarDiffRecords(input({ events: [block()], publishedRemoteIds: published }), secondary())).toEqual([]);
  });

  it("does not list a delete for a linked block whose feed entry was skipped, even when the transport read to the end", () => {
    const read = readFixedBlocks([{ ...block(), title: "" }]);
    expect(read.events).toEqual([]);
    expect(read.complete).toBe(false);
    const transportComplete = true;
    const records = calendarDiffRecords(
      input({
        events: read.events,
        links: [linkOf(block())],
        only: "updates",
        complete: transportComplete && read.complete
      }),
      secondary()
    );
    expect(records).toEqual([]);
  });

  it("is complete only when nothing was skipped", () => {
    expect(readFixedBlocks([block()]).complete).toBe(true);
    expect(readFixedBlocks([]).complete).toBe(true);
  });
});

describe("readFixedBlocks", () => {
  it("skips a bad event, a backwards one and a repeated id, reporting each, and keeps the rest", () => {
    const read = readFixedBlocks([
      block(),
      { ...block({ externalEventId: "bad" }), title: "" },
      block({ externalEventId: "back", startsAt: "2026-08-04T05:30:00.000Z", endsAt: "2026-08-04T00:30:00.000Z" }),
      block(),
      "not an object",
      block({ externalEventId: "ok2" })
    ]);
    expect(read.events.map((e) => e.externalEventId)).toEqual(["b1", "ok2"]);
    expect(read.skipped.map((s) => [s.index, s.externalEventId])).toEqual([
      [1, "bad"],
      [2, "back"],
      [3, "b1"],
      [4, null]
    ]);
  });

  it("skips a zero-length event (end equal to start), which commitments_time_check would reject, and reports it as incomplete", () => {
    const at = "2026-08-04T05:30:00.000Z";
    const read = readFixedBlocks([block({ externalEventId: "zero", startsAt: at, endsAt: at }), block()]);
    expect(read.events.map((e) => e.externalEventId)).toEqual(["b1"]);
    expect(read.skipped).toEqual([{ index: 0, externalEventId: "zero", reason: "Its end is not after its start" }]);
    expect(read.complete).toBe(false);
  });

  it("keeps an event that ends one millisecond after it starts", () => {
    const read = readFixedBlocks([
      block({ externalEventId: "tiny", startsAt: "2026-08-04T05:30:00.000Z", endsAt: "2026-08-04T05:30:00.001Z" })
    ]);
    expect(read.events.map((e) => e.externalEventId)).toEqual(["tiny"]);
    expect(read.complete).toBe(true);
  });

  it("does not list a delete for a linked zero-length block, since a skipped event reads as incomplete", () => {
    const at = "2026-08-04T05:30:00.000Z";
    const zero = block({ externalEventId: "zero", startsAt: at, endsAt: at });
    const read = readFixedBlocks([zero]);
    const records = calendarDiffRecords(
      input({ events: read.events, links: [linkOf(zero)], only: "updates", complete: read.complete }),
      secondary()
    );
    expect(records).toEqual([]);
  });
});
