import { describe, expect, it } from "vitest";
import type { SourceCommitment } from "@openrhen/contracts";
import { handEntryMatchFrom, localDateOf } from "./hand-entry-match";

const tz = "Australia/Sydney";
const existing = (overrides: Partial<SourceCommitment> = {}): SourceCommitment => ({
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
const entry = { title: "Harbor Mart shift", startsAt: "2026-09-29T23:00:00.000Z", endsAt: "2026-09-30T07:00:00.000Z" };

describe("handEntryMatchFrom", () => {
  it("reports a strong match with what the notice shows", () => {
    expect(handEntryMatchFrom(entry, [existing()], tz)).toEqual({
      kind: "strong",
      id: "c1",
      title: "Harbor Mart shift",
      startsAt: "2026-09-29T23:00:00.000Z"
    });
  });

  it("reports a tie as a possible match on the earliest of the tied commitments, never strong", () => {
    const later = existing({ id: "c0", startsAt: "2026-09-29T23:05:00.000Z" });
    expect(handEntryMatchFrom(entry, [later, existing()], tz)).toMatchObject({ kind: "possible", id: "c1" });
  });

  it("reports a possible match for the same times under another title", () => {
    expect(handEntryMatchFrom({ ...entry, title: "Dentist" }, [existing()], tz)?.kind).toBe("possible");
  });

  it("reports nothing for an unrelated commitment or a cancelled one", () => {
    const elsewhere = existing({
      startsAt: "2026-10-03T23:00:00.000Z",
      endsAt: "2026-10-04T07:00:00.000Z",
      localDate: "2026-10-04"
    });
    expect(handEntryMatchFrom(entry, [elsewhere], tz)).toBeNull();
    expect(handEntryMatchFrom(entry, [existing({ status: "cancelled" })], tz)).toBeNull();
    expect(handEntryMatchFrom(entry, [], tz)).toBeNull();
  });

  it("reads the local day in the user's timezone", () => {
    expect(localDateOf(new Date("2026-09-29T23:00:00.000Z"), tz)).toBe("2026-09-30");
  });
});
