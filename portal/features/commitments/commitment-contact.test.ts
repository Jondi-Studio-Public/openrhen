import { describe, expect, it } from "vitest";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import { resolveCommitmentContact } from "./commitment-contact";

const definitions = [
  { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] },
  { id: "archived-contact", name: "Old contact", kind: "contact", status: "archived", channels: [] },
  { id: "campus", name: "Campus", kind: "location", status: "active" }
] as unknown as ConditionDefinition[];

describe("resolveCommitmentContact", () => {
  it("resolves an active contact to its id and name", () => {
    expect(resolveCommitmentContact({ contactId: "sam" }, definitions)).toEqual({ id: "sam", name: "Sam" });
  });

  it("carries the phone and email a prefilled message is addressed to", () => {
    const reachable = [
      {
        id: "sam",
        name: "Sam",
        kind: "contact",
        status: "active",
        channels: [],
        phone: "0400123456",
        email: "s@example.com"
      }
    ] as unknown as ConditionDefinition[];
    expect(resolveCommitmentContact({ contactId: "sam" }, reachable)).toEqual({
      id: "sam",
      name: "Sam",
      phone: "0400123456",
      email: "s@example.com"
    });
  });

  it("resolves undefined for an archived contact", () => {
    expect(resolveCommitmentContact({ contactId: "archived-contact" }, definitions)).toBeUndefined();
  });

  it("resolves undefined for a slug that names nothing", () => {
    expect(resolveCommitmentContact({ contactId: "nobody" }, definitions)).toBeUndefined();
  });

  it("resolves undefined for a slug that names a non-contact condition", () => {
    expect(resolveCommitmentContact({ contactId: "campus" }, definitions)).toBeUndefined();
  });

  it("resolves undefined for an empty or absent value", () => {
    expect(resolveCommitmentContact({ contactId: "" }, definitions)).toBeUndefined();
    expect(resolveCommitmentContact({}, definitions)).toBeUndefined();
  });
});
