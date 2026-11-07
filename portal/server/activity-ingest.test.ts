import { describe, expect, it } from "vitest";
import { parseActivityBody, shorthandKey, stableJson } from "./activity-ingest";

const shortcut = (extra: Record<string, unknown> = {}) => ({
  source: "iphone-shortcuts",
  kind: "app_open",
  start: "2026-11-07T14:58:48+00:00",
  ...extra
});

describe("parseActivityBody: the single-event shorthand", () => {
  it("wraps one event and derives the id by hash when none is given", () => {
    const parsed = parseActivityBody(shortcut({ attrs: { app: "Maps" } }));
    expect(parsed.ok && parsed.shorthand).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.batch.events).toHaveLength(1);
    const wrapped = parsed.batch.events[0] as { id: string; source: string; kind: string };
    expect(wrapped.id).toMatch(/^h:[0-9a-f]{40}$/);
    expect(wrapped).toMatchObject({ source: "iphone-shortcuts", kind: "app_open" });
  });

  it("uses the given id as the event key instead of the hash", () => {
    const parsed = parseActivityBody(shortcut({ id: "my-own-key" }));
    expect(parsed.ok && (parsed.batch.events[0] as { id: string }).id).toBe("my-own-key");
  });

  it("gives the same key to the same fact, and another to a different one", () => {
    const key = (body: Record<string, unknown>) => {
      const parsed = parseActivityBody(body);
      return parsed.ok ? (parsed.batch.events[0] as { id: string }).id : null;
    };
    const a = key(shortcut({ attrs: { b: 1, a: 2 } }));
    expect(key(shortcut({ attrs: { a: 2, b: 1 } }))).toBe(a);
    // The same second written in another offset is the same instant.
    expect(key(shortcut({ start: "2026-11-08T01:58:48+11:00", attrs: { a: 2, b: 1 } }))).toBe(a);
    // Milliseconds are below the key's precision.
    expect(key(shortcut({ start: "2026-11-07T14:58:48.700Z", attrs: { a: 2, b: 1 } }))).toBe(a);
    expect(key(shortcut({ start: "2026-11-07T14:58:49Z", attrs: { a: 2, b: 1 } }))).not.toBe(a);
    expect(key(shortcut({ kind: "app_close", attrs: { a: 2, b: 1 } }))).not.toBe(a);
    expect(key(shortcut({ device: "iphone", attrs: { a: 2, b: 1 } }))).not.toBe(a);
    expect(key(shortcut({ attrs: { a: 3, b: 1 } }))).not.toBe(a);
  });

  it("carries the device to the batch and the offset time through unchanged for the store to normalise", () => {
    const parsed = parseActivityBody(shortcut({ device: "iphone-15" }));
    expect(parsed.ok && parsed.batch.device).toBe("iphone-15");
    expect(parsed.ok && (parsed.batch.events[0] as { start: string }).start).toBe("2026-11-07T14:58:48+00:00");
  });

  it("answers a malformed shorthand in plain words naming the field", () => {
    const parsed = parseActivityBody({ source: "iphone-shortcuts", kind: "wake" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/start/);
    const badTime = parseActivityBody(shortcut({ start: "last tuesday" }));
    expect(badTime.ok).toBe(false);
  });
});

describe("parseActivityBody: batches", () => {
  it("reads a batch, passing the device, import and importId through", () => {
    const sha256 = "b".repeat(64);
    const parsed = parseActivityBody({
      schema: 1,
      device: "pc",
      import: { sha256, filename: "x.json" },
      events: [{ id: "a" }]
    });
    expect(parsed).toMatchObject({
      ok: true,
      shorthand: false,
      batch: { device: "pc", import: { sha256, filename: "x.json" }, events: [{ id: "a" }] }
    });
  });

  it("names the schema version when it is wrong or missing, and says how the body should look", () => {
    for (const body of [{ schema: 2, events: [{}] }, { events: [{}] }, "text", null]) {
      const parsed = parseActivityBody(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/"schema": 1/);
    }
  });

  it("rejects an empty or oversized events list as a whole-request error", () => {
    expect(parseActivityBody({ schema: 1, events: [] }).ok).toBe(false);
    expect(parseActivityBody({ schema: 1, events: Array.from({ length: 1001 }, () => ({})) }).ok).toBe(false);
  });
});

describe("stableJson", () => {
  it("sorts keys at every depth and ignores undefined", () => {
    expect(stableJson({ b: { d: 1, c: [2, { z: 1, y: undefined }] }, a: null })).toBe(
      '{"a":null,"b":{"c":[2,{"z":1}],"d":1}}'
    );
  });
  it("keys on source, kind, second, device and attrs", () => {
    expect(shorthandKey({ source: "s", kind: "k", start: "2026-01-01T00:00:00Z" })).toMatch(/^h:/);
  });
});

describe("parseActivityBody: bad input that must never throw or reach Postgres", () => {
  it("refuses a shorthand with an impossible offset in plain words instead of throwing", () => {
    for (const start of ["2026-11-07T10:00:00+99:99", "2026-11-07T10:00:00+24:00", "2026-02-30T10:00:00Z"]) {
      expect(() => parseActivityBody(shortcut({ start }))).not.toThrow();
      const parsed = parseActivityBody(shortcut({ start }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.error.startsWith(`start "${start}" is not a real time. Send an RFC 3339 time`)).toBe(true);
    }
  });

  it("keeps a batch with a bad time inside one event: the batch is accepted and the store rejects that event", () => {
    const parsed = parseActivityBody({
      schema: 1,
      events: [{ id: "a", source: "x", kind: "y", start: "2026-11-07T10:00:00+99:99" }]
    });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a device with a NUL or a lone surrogate, or one that is not text", () => {
    for (const device of ["a\u0000b", "a\ud800b", 5, ""]) {
      expect(parseActivityBody(shortcut({ device })).ok, String(device)).toBe(false);
      expect(parseActivityBody({ schema: 1, device, events: [{}] }).ok, String(device)).toBe(false);
    }
    const parsed = parseActivityBody(shortcut({ device: "a\u0000b" }));
    if (!parsed.ok) expect(parsed.error).toMatch(/^device contains a NUL character/);
  });

  it("answers every envelope problem in plain words, with no validator text", () => {
    const bodies: [unknown, RegExp][] = [
      [{ schema: 1, events: [] }, /^events must hold 1 to 1000 events/],
      [{ schema: 1 }, /^events must hold 1 to 1000 events/],
      [{ schema: 1, events: "x" }, /^events must hold 1 to 1000 events/],
      [
        { schema: 1, events: Array.from({ length: 1001 }, () => ({})) },
        /^events must hold 1 to 1000 events; this has 1001/
      ],
      [
        { schema: 1, events: [{}], import: { sha256: "short", filename: "x" } },
        /^import\.sha256 must be 64 lowercase hex/
      ],
      [{ schema: 1, events: [{}], import: { sha256: "a".repeat(64) } }, /^import\.filename is missing/],
      [{ schema: 1, events: [{}], importId: "nope" }, /^importId must be the id/]
    ];
    for (const [body, expected] of bodies) {
      const parsed = parseActivityBody(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toMatch(expected);
        expect(parsed.error).not.toMatch(/Invalid|expected|received|Too small|Too big/);
      }
    }
  });
});
