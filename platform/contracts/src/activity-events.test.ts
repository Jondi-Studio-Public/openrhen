import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ATTRS_MAX_BYTES,
  ACTIVITY_CONTENT_MAX_BYTES,
  ACTIVITY_SOURCES,
  activityEnvelopeSchema,
  activityKindsOf,
  activityShorthandSchema,
  ingestActivityEventsSchema,
  isActivityShorthand,
  offsetMinutesOf,
  validateActivityEvent
} from "./activity-events.js";

const now = new Date("2026-11-07T12:00:00.000Z");
const event = (extra: Record<string, unknown> = {}) => ({
  id: "k1",
  source: "rhen-watch",
  kind: "foreground",
  start: "2026-11-07T11:00:00.250Z",
  end: "2026-11-07T11:09:40.900Z",
  ...extra
});
const reason = (raw: unknown) => {
  const verdict = validateActivityEvent(raw, now);
  return verdict.ok ? null : verdict.reason;
};

describe("the source registry", () => {
  it("registers the iPhone sources with the kinds the shortcuts post, at schema version 1", () => {
    expect(ACTIVITY_SOURCES["iphone-shortcuts"]).toEqual({
      schemaVersion: 1,
      kinds: [
        "app_open",
        "app_close",
        "focus_on",
        "focus_off",
        "charger_on",
        "charger_off",
        "place_arrive",
        "place_leave",
        "wifi",
        "wake",
        "alarm"
      ]
    });
    expect(ACTIVITY_SOURCES["iphone-health"]).toEqual({
      schemaVersion: 1,
      kinds: ["steps_day", "sleep", "workout", "heart_rate_day", "energy_day"]
    });
  });

  it("registers gmail messages and the derived facts, at schema version 1", () => {
    expect(ACTIVITY_SOURCES.gmail).toEqual({ schemaVersion: 1, kinds: ["message"] });
    expect(ACTIVITY_SOURCES.derived).toEqual({ schemaVersion: 1, kinds: ["invite", "ask", "fact_status"] });
  });

  it("accepts a correction kind for every source and nothing for an unknown one", () => {
    for (const source of Object.keys(ACTIVITY_SOURCES)) expect(activityKindsOf(source)).toContain("correction");
    expect(activityKindsOf("nope")).toEqual([]);
    expect(activityKindsOf("constructor")).toEqual([]);
  });
});

describe("validateActivityEvent", () => {
  it("accepts a well-formed interval and an instant", () => {
    const verdict = validateActivityEvent(event({ attrs: { exe: "chrome.exe" } }), now);
    expect(verdict).toMatchObject({ ok: true, event: { key: "k1", attrs: { exe: "chrome.exe" }, content: null } });
    expect(validateActivityEvent(event({ end: undefined }), now)).toMatchObject({ ok: true, event: { tsEnd: null } });
    expect(validateActivityEvent(event({ end: null }), now)).toMatchObject({ ok: true, event: { tsEnd: null } });
  });

  it("names the known sources for an unknown one, and the known kinds for an unknown kind", () => {
    expect(reason(event({ source: "myspace" }))).toMatch(/"myspace" is not known\. Use one of: rhen-watch,/);
    expect(reason(event({ source: undefined }))).toMatch(/source is missing/);
    expect(reason(event({ kind: "teleport" }))).toMatch(
      /kind "teleport" is not known for source "rhen-watch"\. Use one of: foreground,/
    );
  });

  it("says what is wrong and how to fix it for end before start, the far future, and size limits", () => {
    expect(reason(event({ end: "2026-11-07T10:00:00Z" }))).toMatch(/before start.*leave end out/);
    expect(reason(event({ start: "2026-11-09T00:00:00Z", end: null }))).toMatch(/24 hours in the future/);
    expect(reason(event({ attrs: { big: "x".repeat(ACTIVITY_ATTRS_MAX_BYTES) } }))).toMatch(/attrs is \d+ bytes/);
    expect(reason(event({ content: "é".repeat(ACTIVITY_CONTENT_MAX_BYTES) }))).toMatch(/content is \d+ bytes/);
    expect(reason(event({ id: "" }))).toMatch(/id:/);
    expect(reason(event({ id: "x".repeat(201) }))).toMatch(/id:/);
    expect(reason("nope")).toMatch(/must be an object/);
    expect(reason(event({ start: "yesterday" }))).toMatch(/start:/);
  });

  it("accepts second precision with an offset, normalises to UTC and fills tz_offset_min from the offset", () => {
    const verdict = validateActivityEvent(
      event({ id: "s", kind: "foreground", start: "2026-11-07T14:58:48+11:00", end: null }),
      now
    );
    expect(verdict).toMatchObject({ ok: true, event: { tzOffsetMin: 660 } });
    if (verdict.ok) expect(verdict.event.tsStart.toISOString()).toBe("2026-11-07T03:58:48.000Z");
    expect(validateActivityEvent(event({ start: "2026-11-07T10:00:00-03:30", end: null }), now)).toMatchObject({
      ok: true,
      event: { tzOffsetMin: -210 }
    });
    expect(validateActivityEvent(event({ start: "2026-11-07T10:00:00+00:00", end: null }), now)).toMatchObject({
      ok: true,
      event: { tzOffsetMin: 0 }
    });
  });

  it("leaves tz_offset_min unknown for a Z time, and lets an explicit tzOffsetMin win", () => {
    expect(validateActivityEvent(event(), now)).toMatchObject({ ok: true, event: { tzOffsetMin: null } });
    expect(
      validateActivityEvent(event({ start: "2026-11-07T10:00:00+11:00", end: null, tzOffsetMin: 600 }), now)
    ).toMatchObject({ ok: true, event: { tzOffsetMin: 600 } });
    expect(reason(event({ tzOffsetMin: 99_999 }))).toMatch(/tzOffsetMin/);
  });
});

describe("offsetMinutesOf", () => {
  it("reads +hh:mm and -hh:mm and says nothing for Z", () => {
    expect(offsetMinutesOf("2026-01-01T00:00:00+05:30")).toBe(330);
    expect(offsetMinutesOf("2026-01-01T00:00:00-08:00")).toBe(-480);
    expect(offsetMinutesOf("2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("the single-event shorthand", () => {
  it("is a body with a source and no events list or schema", () => {
    expect(isActivityShorthand({ source: "iphone-shortcuts", kind: "wake", start: "2026-11-07T06:00:00+11:00" })).toBe(
      true
    );
    expect(isActivityShorthand({ schema: 1, events: [] })).toBe(false);
    expect(isActivityShorthand({ schema: 1, source: "x" })).toBe(false);
    expect(isActivityShorthand([])).toBe(false);
    expect(isActivityShorthand(null)).toBe(false);
  });

  it("takes an optional id, device, end, attrs and content", () => {
    expect(
      activityShorthandSchema.safeParse({
        source: "iphone-shortcuts",
        kind: "wake",
        start: "2026-11-07T06:00:00+11:00"
      }).success
    ).toBe(true);
    expect(
      activityShorthandSchema.safeParse({
        id: "mine",
        device: "iphone",
        source: "iphone-shortcuts",
        kind: "wifi",
        start: "2026-11-07T06:00:00+11:00",
        end: "2026-11-07T07:00:00+11:00",
        attrs: { ssid: "home" }
      }).success
    ).toBe(true);
    expect(activityShorthandSchema.safeParse({ source: "x", kind: "y" }).success).toBe(false);
  });
});

describe("the batch envelope", () => {
  it("requires schema 1 and 1 to 1000 events, leaving each event to be judged alone", () => {
    expect(activityEnvelopeSchema.safeParse({ schema: 1, events: [{ anything: true }] }).success).toBe(true);
    expect(activityEnvelopeSchema.safeParse({ schema: 2, events: [{}] }).success).toBe(false);
    expect(activityEnvelopeSchema.safeParse({ schema: 1, events: [] }).success).toBe(false);
    expect(
      activityEnvelopeSchema.safeParse({ schema: 1, events: Array.from({ length: 1001 }, () => ({})) }).success
    ).toBe(false);
    expect(ingestActivityEventsSchema.safeParse({ schema: 1, events: [{ source: "x" }] }).success).toBe(false);
  });

  it("takes an import reference with a sha256, or an importId, on later batches", () => {
    const base = { schema: 1, events: [{}] };
    const sha256 = "a".repeat(64);
    expect(activityEnvelopeSchema.safeParse({ ...base, import: { sha256, filename: "x.json" } }).success).toBe(true);
    expect(activityEnvelopeSchema.safeParse({ ...base, import: { sha256: "short", filename: "x.json" } }).success).toBe(
      false
    );
    expect(
      activityEnvelopeSchema.safeParse({ ...base, importId: "6f1d0a4e-8c3b-4f7a-9d2e-1b5c7a9e3f10" }).success
    ).toBe(true);
    expect(activityEnvelopeSchema.safeParse({ ...base, importId: "nope" }).success).toBe(false);
  });
});
