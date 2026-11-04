import { describe, expect, it } from "vitest";
import { clampAttentionSince, parseAttentionSince } from "./since";

const NOW = new Date("2026-11-04T12:00:00.000Z");

describe("parseAttentionSince", () => {
  it("accepts an absent value and an ISO date-time with an offset, written back in UTC", () => {
    expect(parseAttentionSince(null)).toEqual({ ok: true });
    expect(parseAttentionSince("2026-11-04T10:00:00+02:00")).toEqual({ ok: true, since: "2026-11-04T08:00:00.000Z" });
  });

  it.each(["yesterday", "", "2026-11-04", "2026-11-04T10:00:00", "not a date"])(
    "refuses %j with the exact fix: the form, an example and what to do with a relative date",
    (raw) => {
      const read = parseAttentionSince(raw);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error).toContain("ISO 8601 date-time with the owner's UTC offset");
      expect(read.error).toContain("2026-11-13T17:00:00-05:00");
      expect(read.error).toContain("status.now");
    }
  );
});

describe("clampAttentionSince", () => {
  it("leaves a value inside the window alone and adds nothing for none", () => {
    expect(clampAttentionSince(undefined, NOW)).toEqual({});
    expect(clampAttentionSince("2026-11-03T00:00:00.000Z", NOW)).toEqual({ since: "2026-11-03T00:00:00.000Z" });
  });

  it("moves a future value to now and an older one to 7 days ago", () => {
    expect(clampAttentionSince("2026-12-01T00:00:00.000Z", NOW)).toEqual({
      since: "2026-11-04T12:00:00.000Z",
      moved: "future"
    });
    expect(clampAttentionSince("2026-10-01T00:00:00.000Z", NOW)).toEqual({
      since: "2026-10-28T12:00:00.000Z",
      moved: "older_than_window"
    });
  });
});
