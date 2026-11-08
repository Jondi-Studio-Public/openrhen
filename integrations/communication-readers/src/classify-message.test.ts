import { describe, expect, it } from "vitest";
import { JSONLD_EVENT_TYPES, JSONLD_ORDER_TYPES, classifyMessage } from "./classify-message.js";

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
    expect(
      classifyMessage({ message_id: "<m@x>", jsonld: [{ "@type": "EventReservation", reservationNumber: "R1" }] })
    ).toEqual({
      class: "calendar",
      reasons: ["jsonld_event"]
    });
    expect(classifyMessage({ message_id: "<m@x>", jsonld: [{ "@type": ["Order"], orderNumber: "O1" }] })).toEqual({
      class: "transaction",
      reasons: ["jsonld_order"]
    });
  });

  it("also accepts a single JSON-LD object keyed @type or type, and finds a type in any array item", () => {
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": "Event" } }).class).toBe("calendar");
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { type: "Order" } }).class).toBe("transaction");
    expect(classifyMessage({ message_id: "<m@x>", jsonld: [{ "@type": "Person" }, { "@type": "Order" }] }).class).toBe(
      "transaction"
    );
  });

  it("matches JSON-LD types exactly against a named list, never by substring", () => {
    for (const type of [
      "EventualThing",
      "Eventide",
      "OrderedList",
      "ReorderAction",
      "Subreservation",
      "InvoiceLine",
      "event",
      "order"
    ]) {
      const result = classifyMessage({ message_id: "<m@x>", jsonld: [{ "@type": type }] });
      expect(result.reasons, type).not.toContain("jsonld_event");
      expect(result.reasons, type).not.toContain("jsonld_order");
    }
    expect(JSONLD_EVENT_TYPES).toContain("FlightReservation");
    expect(JSONLD_ORDER_TYPES).toEqual(expect.arrayContaining(["Order", "Invoice"]));
    for (const type of JSONLD_EVENT_TYPES)
      expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": type } }).class, type).toBe("calendar");
    for (const type of JSONLD_ORDER_TYPES)
      expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": type } }).class, type).toBe("transaction");
  });

  it("lists the real schema.org Event and Reservation subtypes, spelt as schema.org spells them", () => {
    for (const type of [
      "DeliveryEvent",
      "PublicationEvent",
      "BroadcastEvent",
      "OnDemandEvent",
      "SaleEvent",
      "Hackathon",
      "EventSeries",
      "ChildrensEvent",
      "ConferenceEvent",
      "PerformingArtsEvent",
      "ScreeningEvent",
      "TheaterEvent",
      "ExhibitionEvent",
      "SocialEvent",
      "VisualArtsEvent",
      "LiteraryEvent",
      "FoodEvent",
      "EducationEvent",
      "SportsEvent",
      "MusicEvent",
      "DanceEvent",
      "ComedyEvent",
      "BusinessEvent",
      "Festival"
    ])
      expect(JSONLD_EVENT_TYPES, type).toContain(type);
    expect(JSONLD_EVENT_TYPES).not.toContain("ChildrenEvent");
    expect(new Set(JSONLD_EVENT_TYPES).size).toBe(JSONLD_EVENT_TYPES.length);
  });

  it("accepts the schema.org prefixed forms of a listed type, and no other prefix", () => {
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": "http://schema.org/Event" } }).class).toBe(
      "calendar"
    );
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": "https://schema.org/Order" } }).class).toBe(
      "transaction"
    );
    expect(classifyMessage({ message_id: "<m@x>", jsonld: { "@type": "schema:Event" } }).class).toBe("calendar");
    expect(
      classifyMessage({ message_id: "<m@x>", jsonld: { "@type": "http://evil.example/Event" } }).reasons
    ).not.toContain("jsonld_event");
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

  it("fires auth_failed on fail, softfail and permerror, but not on pass, neutral, none or temperror", () => {
    for (const bad of ["fail", "softfail", "permerror"])
      expect(classifyMessage({ message_id: "<m@x>", auth: { dmarc: bad } }).reasons).toContain("auth_failed");
    for (const ok of ["pass", "neutral", "none", "temperror"])
      expect(classifyMessage({ message_id: "<m@x>", auth: { spf: ok } }).reasons).not.toContain("auth_failed");
  });

  it("does not count has_unsubscribe: false as a header", () => {
    expect(classifyMessage({ has_unsubscribe: false }).class).toBe("unknown");
  });

  it("ignores malformed header values rather than throwing", () => {
    expect(classifyMessage({ list_id: 5, auth: "x", ics: "y", jsonld: 3, has_unsubscribe: "yes" }).class).toBe(
      "unknown"
    );
  });
});
