import { describe, expect, it } from "vitest";
import { isoToLocalInput, localInputToIso } from "./datetime-input";

const seedZone = "Australia/Sydney";

describe("datetime input conversion", () => {
  it("shows an ISO time as the wall clock in the reading zone", () => {
    expect(isoToLocalInput("2026-08-20T17:00:00+10:00", seedZone)).toBe("2026-08-20T17:00");
    expect(isoToLocalInput("2026-08-20T07:00:00Z", seedZone)).toBe("2026-08-20T17:00");
  });

  it("writes the wall clock back with the zone's offset, either side of daylight saving", () => {
    expect(localInputToIso("2026-08-20T17:00", seedZone)).toBe("2026-08-20T17:00:00+10:00");
    expect(localInputToIso("2026-12-20T17:00", seedZone)).toBe("2026-12-20T17:00:00+11:00");
  });

  it("round-trips", () => {
    const iso = localInputToIso("2026-10-28T09:30", seedZone)!;
    expect(isoToLocalInput(iso, seedZone)).toBe("2026-10-28T09:30");
  });

  it("leaves text that is not a datetime alone", () => {
    expect(isoToLocalInput("next Tuesday", seedZone)).toBeNull();
    expect(localInputToIso("", seedZone)).toBeNull();
  });

  it("leaves a time with no offset alone rather than reading it in the browser's zone", () => {
    expect(isoToLocalInput("2026-08-20T17:00:00", seedZone)).toBeNull();
    expect(isoToLocalInput("2026-08-20T07:00:00Z", seedZone)).toBe("2026-08-20T17:00");
    expect(isoToLocalInput("2026-08-20T17:00:00.000+10:00", seedZone)).toBe("2026-08-20T17:00");
  });
});
