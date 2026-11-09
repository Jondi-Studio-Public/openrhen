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
