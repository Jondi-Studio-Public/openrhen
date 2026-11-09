import { describe, expect, it } from "vitest";
import { breakTieByContact, contactForSender, normalizeAddress } from "./contact-map.js";

const contacts = [
  { id: "k1", email: "sam@example.test" },
  { id: "k2", email: "Alex@Example.test" },
  { id: "k3", email: null }
];

describe("normalizeAddress", () => {
  it("strips a display name, angle brackets, case and a plus tag", () => {
    expect(normalizeAddress("Sam Example <Sam+school@Example.test>")).toBe("sam@example.test");
    expect(normalizeAddress("  ALEX@example.test ")).toBe("alex@example.test");
    expect(normalizeAddress('"Example, Sam" <sam@example.test>')).toBe("sam@example.test");
  });

  it("returns null for anything that is not an address", () => {
    for (const text of ["", "sam", "@example.test", "sam@", "sam example@test"])
      expect(normalizeAddress(text)).toBeNull();
  });
});

describe("contactForSender", () => {
  it("finds the one contact, whatever the form of either address", () => {
    expect(contactForSender("Sam <sam+x@example.test>", contacts)).toEqual({ kind: "one", id: "k1" });
    expect(contactForSender("alex@example.test", contacts)).toEqual({ kind: "one", id: "k2" });
  });

  it("is none for an unknown address, a contact with no email, or an empty list", () => {
    expect(contactForSender("pat@example.test", contacts)).toEqual({ kind: "none" });
    expect(contactForSender("pat@example.test", [])).toEqual({ kind: "none" });
    expect(contactForSender("", contacts)).toEqual({ kind: "none" });
  });

  it("guesses nothing from a domain or a name", () => {
    expect(contactForSender("sam@other.test", contacts)).toEqual({ kind: "none" });
    expect(contactForSender("sam.example@example.test", contacts)).toEqual({ kind: "none" });
  });

  it("calls two contacts with one address ambiguous, never a pick", () => {
    const shared = [...contacts, { id: "k0", email: "SAM@example.test" }];
    expect(contactForSender("sam@example.test", shared)).toEqual({ kind: "ambiguous", ids: ["k0", "k1"] });
  });
});

describe("breakTieByContact", () => {
  const records = [
    { id: "c1", contactId: "k2" },
    { id: "c2", contactId: "k1" },
    { id: "c3", contactId: "k1" },
    { id: "c4" }
  ];

  it("picks the tied record that belongs to the sender when it is unique", () => {
    expect(breakTieByContact(["c1", "c2"], records, { kind: "one", id: "k1" })).toBe("c2");
    expect(breakTieByContact(["c2", "c1"], records, { kind: "one", id: "k2" })).toBe("c1");
  });

  it("stays a tie when the sender owns none, several, or is not one known contact", () => {
    expect(breakTieByContact(["c1", "c4"], records, { kind: "one", id: "k1" })).toBeNull();
    expect(breakTieByContact(["c2", "c3"], records, { kind: "one", id: "k1" })).toBeNull();
    expect(breakTieByContact(["c1", "c2"], records, { kind: "none" })).toBeNull();
    expect(breakTieByContact(["c1", "c2"], records, { kind: "ambiguous", ids: ["k1", "k2"] })).toBeNull();
  });

  it("ignores owned records that are not in the tie", () => {
    expect(breakTieByContact(["c1", "c4"], records, { kind: "one", id: "k1" })).toBeNull();
    expect(breakTieByContact(["c2", "c4"], records, { kind: "one", id: "k1" })).toBe("c2");
  });
});
