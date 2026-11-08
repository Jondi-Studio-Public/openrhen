import { describe, expect, it } from "vitest";
import { describeDerivedProblem, validateActivityEvent } from "@openrhen/contracts";
import { msgClassT0 } from "./msg-class-t0";

const now = new Date("2026-11-08T00:00:00Z");
const message = (attrs: unknown, key = "g1") => ({
  id: "00000000-0000-0000-0000-000000000001",
  key,
  tsStart: new Date("2026-11-01T00:00:00Z"),
  attrs
});
const BULK = { message_id: "<a@x>", list_id: "<news.example.com>", from: "News <news@example.com>", subject: "Hi" };

describe("msg-class-t0", () => {
  it("names itself and its fixed ingest name", () => {
    expect([msgClassT0.name, msgClassT0.version, msgClassT0.via]).toEqual([
      "msg-class-t0",
      "1",
      "extractor:msg-class-t0"
    ]);
    expect(msgClassT0.input).toEqual({ source: "gmail", kind: "message" });
  });

  it("writes one msg_class row that the same validators the API uses accept", async () => {
    const rows = (await msgClassT0.extract(message(BULK), now)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0] as { id: string; source: string; kind: string; start: string; attrs: Record<string, unknown> };
    expect(row).toMatchObject({ source: "derived", kind: "msg_class", start: "2026-11-01T00:00:00.000Z" });
    expect(row.attrs).toEqual({
      source_event_id: "g1",
      class: "bulk",
      reasons: expect.arrayContaining(["list_id"]),
      tier: "t0",
      extractor: "msg-class-t0",
      extractor_version: "1"
    });
    expect(describeDerivedProblem("msg_class", row.attrs, null)).toBeNull();
    expect(validateActivityEvent(row, now)).toMatchObject({ ok: true });
    expect(row.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("writes no row for a message with no headers, and none for chat-shaped attrs", async () => {
    expect(await msgClassT0.extract(message({}), now)).toEqual([]);
    expect(await msgClassT0.extract(message({ from: "a@b.c", subject: "s", thread_id: "t" }), now)).toEqual([]);
  });

  it("throws, for the runner to count as a failure, when the attrs are not an object", () => {
    for (const attrs of [null, "text", 7, ["a"]])
      expect(() => msgClassT0.extract(message(attrs), now), String(attrs)).toThrow(/attrs/);
  });

  it("keeps the same key when an attr the classifier does not read changes, and a new one when a header it reads does", async () => {
    const key = async (attrs: unknown) => ((await msgClassT0.extract(message(attrs), now)) as { id: string }[])[0]!.id;
    const base = await key(BULK);
    expect(await key({ ...BULK, labels: ["INBOX"], to: ["x@y.z"] })).toBe(base);
    expect(await key({ ...BULK, list_id: "<other.example.com>" })).not.toBe(base);
    expect(await key({ subject: "Hi", from: BULK.from, message_id: BULK.message_id, list_id: BULK.list_id })).toBe(
      base
    );
    expect(((await msgClassT0.extract(message(BULK, "g2"), now)) as { id: string }[])[0]!.id).not.toBe(base);
  });

  it("never emits a kind other than msg_class", async () => {
    for (const attrs of [BULK, { message_id: "<m>", ics: { uid: "u" } }, { message_id: "<m>", in_reply_to: "<p>" }])
      for (const row of (await msgClassT0.extract(message(attrs), now)) as { kind: string }[])
        expect(row.kind).toBe("msg_class");
  });
});
