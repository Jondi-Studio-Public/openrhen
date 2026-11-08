import { describe, expect, it } from "vitest";
import { classifyMessage } from "./classify-message.js";

describe("classifyMessage", () => {
  it("returns unknown with no_headers on empty attrs, never person by default", () => {
    expect(classifyMessage({})).toEqual({ class: "unknown", reasons: ["no_headers"] });
  });

  it("returns unknown for a chat-shaped row that has no mail headers", () => {
    expect(classifyMessage({ thread_id: "c1", from: "a@example.test", from_self: false, direction: "in" })).toEqual({
      class: "unknown",
      reasons: ["no_headers"]
    });
  });

  it("treats an empty header object as absent", () => {
    expect(classifyMessage({ auth: {}, ics: null, list_id: "" }).class).toBe("unknown");
  });

  it("calls a message with an ICS part a calendar message", () => {
    expect(classifyMessage({ message_id: "<m@x>", ics: { uid: "u1", method: "REQUEST" } })).toEqual({
      class: "calendar",
      reasons: ["ics_present"]
    });
  });

  it("reads JSON-LD event and order types", () => {
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { type: "EventReservation" } })).toEqual({
      class: "calendar",
      reasons: ["jsonld_event"]
    });
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { type: ["Order"] } })).toEqual({
      class: "transaction",
      reasons: ["jsonld_order"]
    });
  });

  it("calls a noreply receipt a transaction", () => {
    expect(
      classifyMessage({ message_id: "<m@x>", from: "No-Reply@shop.example", subject: "Your receipt for order 42" })
    ).toEqual({ class: "transaction", reasons: ["receipt_subject", "noreply_sender"] });
  });

  it("does not call a person's receipt subject a transaction", () => {
    expect(classifyMessage({ message_id: "<m@x>", from: "Sam <sam@example.test>", subject: "receipt?" })).toEqual({
      class: "person",
      reasons: ["no_automation_signals"]
    });
  });

  it("calls Auto-Submitted mail automated, but not Auto-Submitted: no", () => {
    expect(classifyMessage({ message_id: "<m@x>", auto_submitted: "auto-generated" })).toEqual({
      class: "automated",
      reasons: ["auto_submitted"]
    });
    expect(classifyMessage({ message_id: "<m@x>", auto_submitted: "no" }).class).toBe("person");
  });

  it("calls list mail and unsubscribable mail bulk", () => {
    expect(classifyMessage({ message_id: "<m@x>", list_id: "<news.example.test>" })).toEqual({
      class: "bulk",
      reasons: ["list_id"]
    });
    expect(classifyMessage({ message_id: "<m@x>", has_unsubscribe: true })).toEqual({
      class: "bulk",
      reasons: ["unsubscribe_header"]
    });
  });

  it("calls a noreply sender automated", () => {
    expect(classifyMessage({ message_id: "<m@x>", from: "donotreply@example.test" })).toEqual({
      class: "automated",
      reasons: ["noreply_sender"]
    });
  });

  it("takes the strongest class and lists every reason in a fixed order", () => {
    expect(
      classifyMessage({ message_id: "<m@x>", list_id: "<l>", has_unsubscribe: true, auto_submitted: "auto-replied" })
    ).toEqual({ class: "automated", reasons: ["auto_submitted", "list_id", "unsubscribe_header"] });
    expect(classifyMessage({ ics: { uid: "u" }, list_id: "<l>" })).toEqual({
      class: "calendar",
      reasons: ["ics_present", "list_id"]
    });
  });

  it("calls plain mail a person, with the reason it looks like a conversation", () => {
    expect(classifyMessage({ message_id: "<m@x>", in_reply_to: "<p@x>", from: "sam@example.test" })).toEqual({
      class: "person",
      reasons: ["in_reply_to"]
    });
    expect(classifyMessage({ message_id: "<m@x>", from_self: true })).toEqual({
      class: "person",
      reasons: ["from_self"]
    });
    expect(classifyMessage({ message_id: "<m@x>" })).toEqual({
      class: "person",
      reasons: ["no_automation_signals"]
    });
  });

  it("adds auth_failed when SPF, DKIM or DMARC failed, without changing the class", () => {
    expect(classifyMessage({ message_id: "<m@x>", auth: { spf: "pass", dkim: "fail" } })).toEqual({
      class: "person",
      reasons: ["auth_failed", "no_automation_signals"]
    });
  });

  it("ignores malformed header values rather than throwing", () => {
    expect(classifyMessage({ list_id: 5, auth: "x", ics: "y", jsonld: 3, has_unsubscribe: "yes" }).class).toBe(
      "unknown"
    );
  });
});
