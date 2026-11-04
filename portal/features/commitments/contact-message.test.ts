import { describe, expect, it } from "vitest";
import {
  contactAddressProblem,
  contactMessageSubject,
  draftContactMessage,
  mailtoHref,
  normaliseContactEmail,
  normaliseContactPhone,
  smsHref
} from "./contact-message";

describe("draftContactMessage", () => {
  const about = "Dentist at 10:00 am";

  it("says how late when the engine projected it, and uses the first name", () => {
    expect(draftContactMessage("Sam Lee", { reason: "late", about, lateMinutes: 7.6 })).toBe(
      "Hi Sam, I'm running about 8 min late for Dentist at 10:00 am."
    );
  });

  it("says running late without a number when there is none", () => {
    expect(draftContactMessage("Sam", { reason: "late", about })).toBe(
      "Hi Sam, I'm running late for Dentist at 10:00 am."
    );
  });

  it("words a displaced and a cancelled commitment", () => {
    expect(draftContactMessage("Sam", { reason: "displaced", about })).toBe(
      "Hi Sam, something's come up and I can't make Dentist at 10:00 am. Can we find another time?"
    );
    expect(draftContactMessage("Sam", { reason: "cancelled", about })).toBe(
      "Hi Sam, I have to cancel Dentist at 10:00 am. Sorry about that."
    );
  });

  it("opens with a greeting alone when there is nothing specific to say", () => {
    expect(draftContactMessage("Sam", {})).toBe("Hi Sam, ");
    expect(draftContactMessage("Sam", { about })).toBe("Hi Sam, about Dentist at 10:00 am: ");
  });
});

describe("contactMessageSubject", () => {
  it("names the reason and the commitment", () => {
    expect(contactMessageSubject({ reason: "late", about: "Dentist" })).toBe("Running late: Dentist");
    expect(contactMessageSubject({ reason: "cancelled", about: "Dentist" })).toBe("Cancelled: Dentist");
    expect(contactMessageSubject({ reason: "displaced", about: "Dentist" })).toBe("About Dentist");
    expect(contactMessageSubject({})).toBe("Something came up");
  });
});

describe("contact addresses", () => {
  it("reduces a typed phone number to digits and a leading plus", () => {
    expect(normaliseContactPhone("0400 123 456")).toBe("0400123456");
    expect(normaliseContactPhone("+61 (400) 123-456")).toBe("+61400123456");
  });

  it("refuses something that is not a phone number", () => {
    expect(normaliseContactPhone("call me")).toBeUndefined();
    expect(normaliseContactPhone("12")).toBeUndefined();
    expect(normaliseContactPhone("")).toBeUndefined();
  });

  it("accepts a plain email and refuses a malformed one", () => {
    expect(normaliseContactEmail(" sam@example.com ")).toBe("sam@example.com");
    expect(normaliseContactEmail("sam@example")).toBeUndefined();
    expect(normaliseContactEmail("sam @example.com")).toBeUndefined();
  });

  it("names the problem for Settings and the server, and passes empty values", () => {
    expect(contactAddressProblem({})).toBeUndefined();
    expect(contactAddressProblem({ phone: " ", email: "" })).toBeUndefined();
    expect(contactAddressProblem({ phone: "abc" })).toBe("That phone number doesn't look right.");
    expect(contactAddressProblem({ email: "nope" })).toBe("That email address doesn't look right.");
  });
});

describe("compose links", () => {
  it("builds an sms link both iOS and Android read, with the body encoded", () => {
    expect(smsHref("0400 123 456", "Late & sorry?")).toBe("sms:0400123456?&body=Late%20%26%20sorry%3F");
    expect(smsHref("nope", "x")).toBeUndefined();
  });

  it("builds a mailto link with the subject and body encoded", () => {
    expect(mailtoHref("sam@example.com", "Running late: Dentist", "Hi Sam,\nsoon")).toBe(
      "mailto:sam@example.com?subject=Running%20late%3A%20Dentist&body=Hi%20Sam%2C%0Asoon"
    );
    expect(mailtoHref("nope", "s", "b")).toBeUndefined();
  });
});
