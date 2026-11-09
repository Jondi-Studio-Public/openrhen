import { describe, expect, it } from "vitest";
import { ACTIVITY_SOURCES, validateActivityEvent } from "./activity-events.js";
import type { ActivitySourceEntry } from "./activity-events.js";
import {
  MESSAGE_FAMILY,
  canonicalMessageKey,
  describeMessageProblem,
  messageFingerprint,
  normaliseMessageId,
  normaliseMessageText
} from "./activity-message.js";

const now = new Date("2026-11-09T12:00:00.000Z");
const START = "2026-11-08T10:15:42Z";
const registry: Record<string, ActivitySourceEntry> = {
  ...ACTIVITY_SOURCES,
  "demo-inbox": { schemaVersion: 1, kinds: ["message"], family: MESSAGE_FAMILY }
};
const verdict = (raw: unknown) => validateActivityEvent(raw, now, { registry });
const reason = (raw: unknown) => {
  const v = verdict(raw);
  return v.ok ? null : v.reason;
};
const post = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "mid:One@example.com",
  source: "demo-inbox",
  kind: "message",
  start: START,
  attrs: { message_id: "<One@Example.com>", from: "alex@example.com", ...attrs },
  ...extra
});

describe("the message@1 fingerprint", () => {
  it("differs for another sender or other text, and does not depend on time", () => {
    const base = messageFingerprint("alex@example.com", "Hello world");
    expect(messageFingerprint("sam@example.com", "Hello world")).not.toBe(base);
    expect(messageFingerprint("alex@example.com", "Hello worlds")).not.toBe(base);
  });

  it("has none for text that normalises to nothing, and cuts long text at 8192 code points", () => {
    expect(messageFingerprint("a@example.com", " ​﻿\n ")).toBeUndefined();
    expect(messageFingerprint("a@example.com", "x".repeat(8192))).toBe(
      messageFingerprint("a@example.com", "x".repeat(9000))
    );
    expect(messageFingerprint("a@example.com", "x".repeat(8191))).not.toBe(
      messageFingerprint("a@example.com", "x".repeat(8192))
    );
    expect(normaliseMessageText("A  B")).toBe("a b");
  });
});

describe("message@1 canonical keys", () => {
  it("normalises an id: brackets off, only the domain lower-cased, ids without @ as given", () => {
    expect(normaliseMessageId(" <Local.PART@Host.EXAMPLE> ")).toBe("Local.PART@host.example");
    expect(normaliseMessageId("a@b@C.D")).toBe("a@b@c.d");
    expect(normaliseMessageId("MsgID-ABC")).toBe("MsgID-ABC");
    expect(normaliseMessageId("<>")).toBe("");
  });

  it("is undefined with neither an id nor usable text", () => {
    expect(canonicalMessageKey({ sender: "a", tsStart: new Date(0), content: null })).toBeUndefined();
    expect(canonicalMessageKey({ messageId: " ", sender: "a", tsStart: new Date(0), content: " " })).toBeUndefined();
  });
});

describe("validateActivityEvent for a message@1 source", () => {
  it("accepts a message with an id, tidies attrs, and computes fp from the raw content", () => {
    const v = verdict(
      post(
        { to: ["Sam@Example.com", "Sam Example"], direction: "in", from: "Alex@Example.com" },
        { content: "Hello world" }
      )
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.event.key).toBe("mid:One@example.com");
    expect(v.event.attrs).toMatchObject({
      message_id: "One@example.com",
      from: "alex@example.com",
      to: ["sam@example.com", "Sam Example"],
      fp: messageFingerprint("alex@example.com", "Hello world")
    });
  });

  it("keys on the id first: the id key wins over the fp key", () => {
    expect(reason(post({}, { id: "mid:One@example.com", content: "Hi" }))).toBeNull();
  });

  it("accepts a bare event: an id and no text, with no fp", () => {
    const v = verdict(post({ channel: "inbox-1", from: "Notifier" }, { id: "mid:One@example.com" }));
    expect(v.ok && v.event.attrs.fp).toBeFalsy();
    expect(v.ok && v.event.attrs.from).toBe("Notifier");
  });

  it("accepts a message with no id, keyed fp: over sender, minute and text", () => {
    const attrs = { from: "alex@example.com" };
    const id = canonicalMessageKey({ sender: "alex@example.com", tsStart: new Date(START), content: "Hello world" });
    const v = verdict({ id, source: "demo-inbox", kind: "message", start: START, attrs, content: "Hello world" });
    expect(v.ok).toBe(true);
    expect(id).toMatch(/^fp:[0-9a-f]{40}$/);
  });

  it("names the expected key when the id is wrong", () => {
    expect(reason(post({}, { id: "wrong" }))).toContain('send id "mid:One@example.com"');
    const text = reason({
      id: "x",
      source: "demo-inbox",
      kind: "message",
      start: START,
      attrs: { from: "a@example.com" },
      content: "Hi"
    });
    expect(text).toMatch(/send id "fp:[0-9a-f]{40}"/);
  });

  it("hashes an id too long for a key", () => {
    const longId = "x".repeat(200);
    const key = canonicalMessageKey({ messageId: longId, sender: "a", tsStart: new Date(0), content: null });
    expect(key).toMatch(/^mid:[0-9a-f]{40}$/);
    expect(reason(post({ message_id: longId }, { id: key }))).toBeNull();
  });

  it("rejects no id and no content, with the fix", () => {
    const text = reason({
      id: "anything",
      source: "demo-inbox",
      kind: "message",
      start: START,
      attrs: { from: "a@example.com" }
    });
    expect(text).toContain("attrs.message_id");
    expect(text).toContain("content");
  });

  it("rejects a sent fp, an unknown attr, and a missing from, each naming the fix", () => {
    expect(reason(post({ fp: "0".repeat(32) }, { content: "Hi" }))).toBe(
      "attrs.fp is computed by the server; leave fp out."
    );
    expect(reason(post({ labels: ["x"] }))).toContain(
      "Allowed: message_id, from, to, from_self, direction, channel, thread_id, subject."
    );
    const noFrom = { ...post({}), attrs: { message_id: "m1" } };
    expect(reason(noFrom)).toContain("attrs.from is required");
  });

  it("rejects bad field shapes", () => {
    expect(reason(post({ direction: "sideways" }))).toContain("one of: in, out");
    expect(reason(post({ from_self: "yes" }))).toContain("true or false");
    expect(reason(post({ to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }))).toContain("at most 20");
    expect(reason(post({ channel: "c".repeat(129) }))).toContain("attrs.channel");
    expect(reason(post({ subject: "s".repeat(201) }))).toContain("attrs.subject");
    expect(reason(post({ message_id: "<>" }))).toContain("empty once its angle brackets");
    expect(reason(post({}, { end: "2026-11-08T10:20:00Z" }))).toContain("instant");
  });

  it("leaves a source outside the family alone, and no core source is in it", () => {
    const outside = {
      id: "m1",
      source: "demo-legacy",
      kind: "message",
      start: START,
      attrs: { thread_id: "t1", labels: ["INBOX"], message_id: "<A@B>" }
    };
    const own = { ...registry, "demo-legacy": { schemaVersion: 1, kinds: ["message"] } };
    const v = validateActivityEvent(outside, now, { registry: own });
    expect(v.ok && v.event.attrs).toEqual(outside.attrs);
    expect(Object.values(ACTIVITY_SOURCES).filter((entry) => entry.family === MESSAGE_FAMILY)).toEqual([]);
  });

  it("does not touch a non-message kind on a family source", () => {
    expect(
      describeMessageProblem({
        id: "k",
        kind: "correction",
        tsStart: new Date(0),
        tsEnd: null,
        content: null,
        attrs: { any: 1 }
      })
    ).toEqual({
      ok: true,
      attrs: { any: 1 }
    });
  });
});

describe("message@1 plain-text fields and bounds", () => {
  const withKey = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => post(attrs, extra);

  it("refuses newline, control, line separator, zero-width and bidi characters in from, to, subject, channel and thread_id", () => {
    const bads = [
      "a\nb",
      "a\tb",
      "a\u0007b",
      "a\u2028b",
      "a\u2029b",
      "a\u200bb",
      "a\u2060b",
      "a\ufeffb",
      "a\u202eb",
      "a\u2066b",
      "a\u{e0041}b",
      "\u200b"
    ];
    for (const bad of bads) {
      for (const attrs of [
        { from: `x${bad}@example.com` },
        { to: [`x${bad}@example.com`] },
        { subject: `Hi ${bad}` },
        { channel: bad },
        { thread_id: bad }
      ]) {
        const r = reason(withKey(attrs));
        expect(r, JSON.stringify([bad, attrs])).toContain("not allowed");
        expect(r).toContain("plain text on one line");
      }
    }
  });

  it("keeps ZWNJ, ZWJ and ordinary non-Latin text, and trims what it stores", () => {
    const v = verdict(
      post({
        from: "  \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645  ",
        to: [" Sam@Example.com "],
        subject: "  \u0915\u094d\u200d\u0937  ",
        channel: " inbox ",
        thread_id: " t-1 "
      })
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.event.attrs).toMatchObject({
      from: "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
      to: ["sam@example.com"],
      subject: "\u0915\u094d\u200d\u0937",
      channel: "inbox",
      thread_id: "t-1"
    });
  });

  it("screens whitespace and hidden characters in message_id", () => {
    for (const id of ["a b@example.com", "<a\tb@example.com>", "a\nb", "a\u200bb@example.com", "a\u00a0b"]) {
      const r = reason(post({ message_id: id }, { id: "mid:x" }));
      expect(r, JSON.stringify(id)).toMatch(/whitespace|not allowed/u);
    }
    expect(reason(post({ message_id: " <One@Example.com> " }))).toBeNull();
  });

  it("refuses a start at or before 1990", () => {
    expect(reason(post({}, { start: "1970-01-01T00:00:00Z" }))).toContain("must be after 1990-01-01");
    expect(reason(post({}, { start: "1990-01-01T00:00:00Z" }))).toContain("must be after 1990-01-01");
    expect(reason(post({}))).toBeNull();
  });

  it("names the family in the coverage-not-accepted fix for a source outside it", () => {
    const r = reason({
      id: "cov:_:2026-11-08T00:00:00.000Z:2026-11-08T01:00:00.000Z",
      source: "physiology",
      kind: "coverage",
      start: "2026-11-08T00:00:00Z",
      end: "2026-11-08T01:00:00Z",
      attrs: { complete: true }
    });
    expect(r).toContain("message@1");
  });

  it("gives an equal fp to an NFC twin and a different one to a soft hyphen, and pins that fp has no time", () => {
    const a = messageFingerprint("a@example.com", "Caf\u00e9");
    expect(messageFingerprint("a@example.com", "Cafe\u0301")).toBe(a);
    expect(messageFingerprint("a@example.com", "co\u00admfort")).not.toBe(
      messageFingerprint("a@example.com", "comfort")
    );
    const early = verdict(withKey({}, { content: "Hello", start: "2026-11-08T10:15:00Z" }));
    const late = verdict(withKey({}, { content: "Hello", start: "2026-11-08T11:45:00Z" }));
    expect(early.ok && late.ok && early.event.attrs?.fp).toBe(late.ok && late.event.attrs?.fp);
  });
});
