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
    expect(ACTIVITY_SOURCES.derived).toEqual({
      schemaVersion: 1,
      kinds: ["msg_class", "fact", "fact_status", "override", "label"]
    });
  });

  it("registers derived-shadow with the extractor kinds only (msg_class, fact), and no correction kind", () => {
    expect(ACTIVITY_SOURCES["derived-shadow"]).toEqual({ schemaVersion: 1, kinds: ["msg_class", "fact"] });
    expect(activityKindsOf("derived-shadow")).toEqual(["msg_class", "fact"]);
  });

  it("refuses fact_status, override, label and correction in derived-shadow, for every writer, naming the allowed kinds", () => {
    for (const kind of ["fact_status", "override", "label", "correction"]) {
      const verdict = validateActivityEvent(
        {
          id: "s1",
          source: "derived-shadow",
          kind,
          start: "2026-11-07T11:00:00Z",
          attrs: { fact_id: "a".repeat(40), answer: "x", field: "fact_type" }
        },
        now
      );
      expect(verdict.ok, kind).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason, kind).toContain("msg_class, fact");
        expect(verdict.reason, kind).toContain(`"${kind}"`);
      }
    }
  });

  it("holds a derived-shadow row to the derived rules: the same attrs validators, no body, no client by", () => {
    const row = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      validateActivityEvent(
        { id: "s1", source: "derived-shadow", kind: "msg_class", start: "2026-11-07T11:00:00Z", attrs, ...extra },
        now
      );
    const good = {
      source_event_id: "g1",
      class: "bulk",
      reasons: ["list_id"],
      extractor: "msg-class-t0",
      extractor_version: "2"
    };
    expect(row(good).ok).toBe(true);
    expect(row({ ...good, class: "spam" })).toMatchObject({ ok: false });
    expect(row({ ...good, by: "me" })).toMatchObject({ ok: false });
    expect(row(good, { content: "the body" })).toMatchObject({ ok: false });
  });

  it("accepts a correction kind for every source and nothing for an unknown one", () => {
    // derived-shadow is the exception: it holds extractor output only.
    for (const source of Object.keys(ACTIVITY_SOURCES).filter((name) => name !== "derived-shadow"))
      expect(activityKindsOf(source)).toContain("correction");
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
    expect(reason(event({ id: "" }))).toMatch(/^id is missing/);
    expect(reason(event({ id: "x".repeat(201) }))).toMatch(/^id is 201 characters/);
    expect(reason("nope")).toMatch(/must be an object/);
    expect(reason(event({ start: "yesterday" }))).toMatch(/^start "yesterday" is not a real time/);
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
    expect(reason(event({ tzOffsetMin: 99_999 }))).toMatch(/^tzOffsetMin must be/);
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

describe("validateActivityEvent: impossible times, text Postgres refuses, and plain messages", () => {
  const BAD_OFFSETS = ["+99:99", "+24:00", "+14:01", "-12:60", "+05:99", "-15:00"];

  it.each(BAD_OFFSETS)("rejects the offset %s for this event with a plain message, never throwing", (offset) => {
    const verdict = validateActivityEvent(event({ start: `2026-11-07T10:00:00${offset}`, end: null }), now);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reason).toBe(
        `start "2026-11-07T10:00:00${offset}" is not a real time. Send an RFC 3339 time such as "2026-11-07T14:02:11Z" or "2026-11-07T14:02:11+11:00" (an offset runs from -14:00 to +14:00).`
      );
  });

  it("rejects a date that does not exist, and a year Postgres cannot hold", () => {
    expect(reason(event({ start: "2026-02-30T10:00:00Z", end: null }))).toMatch(
      /start "2026-02-30T10:00:00Z" is not a real time/
    );
    expect(reason(event({ start: "0000-01-01T00:00:00Z", end: null }))).toMatch(/outside the years 1970 to 2200/);
    expect(reason(event({ start: "2026-11-07T24:00:00Z", end: null }))).toMatch(/is not a real time/);
    expect(reason(event({ start: "2026-11-07T10:00:00Z", end: "2026-13-01T00:00:00Z" }))).toMatch(
      /end "2026-13-01T00:00:00Z" is not a real time/
    );
  });

  it("rejects a NUL or a lone surrogate in the id, content, or anywhere in attrs (keys and values)", () => {
    const lone = "a\ud800b";
    for (const [name, extra] of [
      ["id", { id: "a\u0000b" }],
      ["id", { id: lone }],
      ["content", { content: "x\u0000y" }],
      ["content", { content: lone }],
      ["attrs", { attrs: { app: "x\u0000y" } }],
      ["attrs", { attrs: { nested: [{ deep: lone }] } }],
      ["attrs", { attrs: { ["k\u0000"]: 1 } }]
    ] as const) {
      const message = reason(event(extra));
      expect(message, `${name} ${JSON.stringify(extra)}`).toMatch(
        new RegExp(`^${name} contains (a NUL character|a lone surrogate)`)
      );
      expect(message).toMatch(/Remove or replace it/);
    }
    expect(validateActivityEvent(event({ content: "emoji 😀 fine" }), now).ok).toBe(true);
  });

  it("rejects attrs nested too deeply to check", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect(reason(event({ attrs: deep }))).toMatch(/^attrs nests deeper than 20 levels/);
  });

  it("says what to send, in plain words, for each field that is wrong (no validator jargon)", () => {
    expect(reason(event({ start: undefined }))).toBe(
      'start is missing. Send an RFC 3339 time such as "2026-11-07T14:02:11Z" or "2026-11-07T14:02:11+11:00".'
    );
    expect(reason(event({ start: "yesterday" }))).toBe(
      'start "yesterday" is not a real time. Send an RFC 3339 time such as "2026-11-07T14:02:11Z" or "2026-11-07T14:02:11+11:00" (an offset runs from -14:00 to +14:00).'
    );
    expect(reason(event({ end: 5 }))).toMatch(/^end must be a time as text/);
    expect(reason(event({ id: undefined }))).toBe(
      'id is missing. Send a text key of 1 to 200 characters that is the same each time you send this event, such as "phone-2026-11-07T14:02:11".'
    );
    expect(reason(event({ id: "x".repeat(201) }))).toBe(
      "id is 201 characters long; the limit is 200. Send a shorter key."
    );
    expect(reason(event({ attrs: [1] }))).toBe(
      'attrs must be an object of small facts such as {"app": "Maps"}, or left out.'
    );
    expect(reason(event({ attrs: "text" }))).toMatch(/^attrs must be an object/);
    expect(reason(event({ content: 5 }))).toBe("content must be text, or left out.");
    expect(reason(event({ approximate: "yes" }))).toBe("approximate must be true or false, or left out.");
    expect(reason(event({ tzOffsetMin: "11" }))).toBe(
      "tzOffsetMin must be a whole number of minutes east of UTC between -840 and 840 (Sydney in summer is 660), or left out."
    );
    for (const message of [
      reason(event({ start: undefined })),
      reason(event({ attrs: [1] })),
      reason(event({ id: "" }))
    ])
      expect(message).not.toMatch(/Invalid|expected|received|Too small|Too big/);
  });

  it("accepts attrs: null as no attrs", () => {
    expect(validateActivityEvent(event({ attrs: null }), now)).toMatchObject({ ok: true, event: { attrs: {} } });
  });
});
