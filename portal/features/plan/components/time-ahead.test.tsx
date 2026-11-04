// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { ClientCapacityEnvelope } from "@/state/portal-provider";
import { TimeAhead, bandName, hoursText } from "@/features/plan/components/time-ahead";

const band = (overrides: Partial<ClientCapacityEnvelope> = {}): ClientCapacityEnvelope => ({
  kind: "detailed",
  confidence: "high",
  capacityFactor: 0.9,
  startsAt: new Date("2026-10-27T13:00:00.000Z"),
  endsAt: new Date("2026-11-03T13:00:00.000Z"),
  rawCapacityMinutes: 600,
  adjustedCapacityMinutes: 500,
  protectedKnownMinutes: 100,
  reservedMinutes: 250,
  freeMinutes: 250,
  ...overrides
});
const tz = "Australia/Sydney";

describe("TimeAhead", () => {
  it("names the first two bands by week and the rest by their calendar span", () => {
    expect(bandName(band(), tz)).toBe("Next 7 days");
    expect(bandName(band({ kind: "daily" }), tz)).toBe("The week after");
    const weekly = band({
      kind: "weekly",
      startsAt: new Date("2026-11-10T13:00:00.000Z"),
      endsAt: new Date("2026-11-26T13:00:00.000Z")
    });
    expect(bandName(weekly, tz)).toBe("11–26 Nov");
    const fortnightly = band({
      kind: "fortnightly",
      startsAt: new Date("2026-11-26T13:00:00.000Z"),
      endsAt: new Date("2027-01-25T13:00:00.000Z")
    });
    expect(bandName(fortnightly, tz)).toBe("Nov to Jan");
  });

  it("writes hours to one decimal under a hundred and whole above", () => {
    expect(hoursText(2136)).toBe("35.6 h");
    expect(hoursText(7860)).toBe("131 h");
  });

  it("states free hours of what can be counted on, with a meter of what is set aside", () => {
    render(<TimeAhead bands={[band()]} timezone={tz} />);
    expect(screen.getByRole("heading", { name: "Time ahead" })).toBeTruthy();
    expect(screen.getAllByText(/free of 8.3 h/).length).toBeGreaterThan(0);
    expect(screen.getByRole("meter", { name: /Next 7 days/ }).getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("leaves the meter empty rather than dividing by a band with no time", () => {
    render(<TimeAhead bands={[band({ adjustedCapacityMinutes: 0 })]} timezone={tz} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
  });

  it("explains the arithmetic in a sheet, in plain words", () => {
    render(<TimeAhead bands={[band()]} timezone={tz} />);
    fireEvent.click(screen.getByRole("button", { name: "How this is counted" }));
    for (const text of [
      "Total time",
      "Taken by fixed plans",
      "Counted on (90%)",
      "Set aside for projects",
      "Still free"
    ])
      expect(screen.getByText(text)).toBeTruthy();
  });

  it("draws nothing without bands", () => {
    const { container } = render(<TimeAhead bands={[]} timezone={tz} />);
    expect(container.firstChild).toBeNull();
  });
});
