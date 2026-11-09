import { describe, expect, it } from "vitest";
import type { SourceCommitment } from "@openrhen/contracts";
import { classifySourceEvent, type SourceEventInput } from "./source-match-records";

const commitment = (overrides: Partial<SourceCommitment> = {}): SourceCommitment => ({
  id: "c1",
  title: "Harbor Mart shift",
  startsAt: "2026-09-29T23:00:00.000Z",
  endsAt: "2026-09-30T07:00:00.000Z",
  allDay: false,
  localDate: "2026-09-30",
  status: "confirmed",
  links: [],
  ...overrides
});
const event: SourceEventInput = {
  provider: "example_shared",
  externalId: "sk1",
  title: "Harbor Mart shift",
  startsAt: "2026-09-29T23:00:00.000Z",
  endsAt: "2026-09-30T07:00:00.000Z",
  timezone: "Australia/Sydney"
};

describe("classifySourceEvent", () => {
  it("links nothing on its own for one strong match", () => {
    const result = classifySourceEvent(event, { commitments: [commitment()], aliases: [] });
    expect(result).toMatchObject({ kind: "strong", commitment: { id: "c1" } });
  });

  it("holds two equal strong matches as a possible match on the earliest, never an auto-link", () => {
    const result = classifySourceEvent(event, {
      commitments: [commitment({ id: "c2", startsAt: "2026-09-29T23:05:00.000Z" }), commitment()],
      aliases: []
    });
    expect(result).toMatchObject({
      kind: "possible",
      reason: "Two commitments fit equally",
      commitment: { id: "c1" }
    });
  });

  it("holds two commitments that both claim the event as a possible match, never a silent skip", () => {
    const marked = { ...event, description: "OpenRhen:c1 OpenRhen:c2" };
    const result = classifySourceEvent(marked, {
      commitments: [commitment({ id: "c2", title: "Other" }), commitment({ title: "Another" })],
      aliases: []
    });
    expect(result).toMatchObject({
      kind: "possible",
      reason: "Two commitments claim this event",
      commitment: { id: "c1" }
    });
  });

  it("still skips one exact match", () => {
    const marked = { ...event, description: "OpenRhen:c1" };
    expect(classifySourceEvent(marked, { commitments: [commitment()], aliases: [] })).toEqual({ kind: "skip" });
  });

  it("holds two equal possible matches the same way", () => {
    const result = classifySourceEvent(
      { ...event, title: "Dentist" },
      { commitments: [commitment({ id: "c2" }), commitment()], aliases: [] }
    );
    expect(result).toMatchObject({ kind: "possible", reason: "Two commitments fit equally" });
  });
});
