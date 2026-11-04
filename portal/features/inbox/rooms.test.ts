import { describe, expect, it, vi } from "vitest";
import { registerFakeMailSource } from "@/test/fake-mail-source";
import {
  emptyRoomCounts,
  filterHref,
  inboxBadge,
  roomById,
  roomForPath,
  rooms,
  visibleRooms,
  type RoomCounts
} from "./rooms";

// The core rules hold with the seam empty, as in the OpenRhen export; a fake provider stands in below.
vi.mock("@/state/private/index", () => ({}));

const counts = (extra: Partial<RoomCounts>): RoomCounts => ({ ...emptyRoomCounts, ...extra });

describe("rooms", () => {
  it("lists the rooms in chip order with their labels", () => {
    expect(rooms.map((room) => [room.id, room.label])).toEqual([
      ["emails", "Emails"],
      ["people", "From people"],
      ["captured", "Captured"],
      ["calendar", "Calendar"],
      ["map", "Links"],
      ["kept", "Kept for later"]
    ]);
  });

  it("gives every room its own address under /inbox", () => {
    for (const room of rooms) expect(room.href).toBe(`/inbox/${room.id}`);
  });

  it("hides the Emails room until a mail provider is installed", () => {
    expect(visibleRooms().map((room) => room.id)).toEqual(["people", "captured", "calendar", "map", "kept"]);
    registerFakeMailSource();
    expect(visibleRooms().map((room) => room.id)).toEqual(rooms.map((room) => room.id));
  });

  it("finds a room by id", () => {
    expect(roomById("map").label).toBe("Links");
  });
});

describe("filterHref", () => {
  it("is /inbox for everything and the room's address otherwise", () => {
    expect(filterHref("all")).toBe("/inbox");
    expect(filterHref("emails")).toBe("/inbox/emails");
    expect(filterHref("kept")).toBe("/inbox/kept");
  });
});

describe("inboxBadge", () => {
  it("sums every room that needs a decision and leaves kept items out", () => {
    const all = counts({ emails: 2, people: 1, captured: 3, calendar: 4, map: 5, kept: 7 });
    expect(inboxBadge(all)).toBe(15);
  });

  it("equals the sum of the badged rooms", () => {
    const all = counts({ emails: 1, people: 2, captured: 3, calendar: 4, map: 5, kept: 6 });
    const listed = rooms.filter((room) => room.badged).reduce((sum, room) => sum + all[room.id], 0);
    expect(inboxBadge(all)).toBe(listed);
  });

  it("is zero when nothing waits", () => {
    expect(inboxBadge(emptyRoomCounts)).toBe(0);
    expect(inboxBadge(counts({ kept: 3 }))).toBe(0);
  });
});

describe("roomForPath", () => {
  it("names the room a path belongs to", () => {
    expect(roomForPath("/inbox/emails")?.id).toBe("emails");
    expect(roomForPath("/inbox/calendar/")?.id).toBe("calendar");
    expect(roomForPath("/inbox/map?x=1")?.id).toBe("map");
    expect(roomForPath("/inbox?x=1")).toBeNull();
    expect(roomForPath("/inbox")).toBeNull();
    expect(roomForPath("/today")).toBeNull();
    expect(roomForPath(null)).toBeNull();
  });
});
