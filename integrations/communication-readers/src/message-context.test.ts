import { describe, expect, it } from "vitest";
import { MAX_WHO, messageFactContext } from "./message-context.js";

const IN = { thread_id: "18c0ffee", from: "Alex <alex@example.test>", from_self: false, to: ["me@example.test"] };

describe("messageFactContext: direction, who and the conversation key come from the collector, not a model", () => {
  it("reads an inbound message: direction in, who the sender as written, key gmail:<thread id>", () => {
    expect(messageFactContext("gmail", IN)).toEqual({
      ok: true,
      direction: "in",
      who: ["Alex <alex@example.test>"],
      conversationKey: "gmail:18c0ffee"
    });
  });

  it("reads an outbound message: direction out, who up to 3 recipients as typed", () => {
    const out = {
      thread_id: "t9",
      from_self: true,
      from: "me@example.test",
      to: ["A <a@example.test>", "b@example.test", "b@example.test", "c@example.test", "d@example.test"]
    };
    expect(messageFactContext("gmail", out)).toEqual({
      ok: true,
      direction: "out",
      who: ["A <a@example.test>", "b@example.test", "c@example.test"],
      conversationKey: "gmail:t9"
    });
    expect(MAX_WHO).toBe(3);
  });

  it("ignores a direction attr and decides by from_self alone", () => {
    expect(messageFactContext("gmail", { ...IN, direction: "out" })).toMatchObject({ direction: "in" });
    expect(messageFactContext("gmail", { ...IN, from_self: true, direction: "in" })).toMatchObject({
      ok: true,
      direction: "out"
    });
  });

  it("refuses with a reason rather than guessing", () => {
    const fail = (source: string, attrs: Record<string, unknown>) => messageFactContext(source, attrs);
    expect(fail("gmail", { ...IN, from_self: undefined })).toEqual({ ok: false, reason: "no_from_self" });
    expect(fail("gmail", { ...IN, from_self: "false" })).toEqual({ ok: false, reason: "no_from_self" });
    expect(fail("discord", IN)).toEqual({ ok: false, reason: "not_gmail" });
    expect(fail("gmail", { ...IN, thread_id: undefined })).toEqual({ ok: false, reason: "no_thread_id" });
    expect(fail("gmail", { ...IN, thread_id: "a b" })).toEqual({ ok: false, reason: "no_thread_id" });
    expect(fail("gmail", { ...IN, thread_id: "x".repeat(129) })).toEqual({ ok: false, reason: "no_thread_id" });
    expect(fail("gmail", { ...IN, from: "  " })).toEqual({ ok: false, reason: "no_sender" });
    expect(fail("gmail", { ...IN, from: undefined })).toEqual({ ok: false, reason: "no_sender" });
    expect(fail("gmail", { ...IN, from: "a\nb@x" })).toEqual({ ok: false, reason: "no_sender" });
    expect(fail("gmail", { ...IN, from_self: true, to: [] })).toEqual({ ok: false, reason: "no_recipients" });
    expect(fail("gmail", { ...IN, from_self: true, to: "a@x" })).toEqual({ ok: false, reason: "no_recipients" });
  });

  it("drops a repeated recipient by its address, case aside, and keeps the first spelling as typed", () => {
    const out = {
      thread_id: "t",
      from_self: true,
      to: ["Bob <Bob@Example.test>", "bob@example.test", "BOB@EXAMPLE.TEST", "c@example.test"]
    };
    expect(messageFactContext("gmail", out)).toMatchObject({ who: ["Bob <Bob@Example.test>", "c@example.test"] });
  });

  it("skips a recipient that is not usable text and keeps the rest", () => {
    expect(messageFactContext("gmail", { ...IN, from_self: true, to: [5, "", "ok@example.test"] })).toMatchObject({
      ok: true,
      who: ["ok@example.test"]
    });
  });
});
