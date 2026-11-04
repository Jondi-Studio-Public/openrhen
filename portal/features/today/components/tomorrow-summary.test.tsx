// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { zonedDayBounds } from "@/features/today/local-datetime";
import type { TomorrowBrief } from "@/features/today/tomorrow-preview";
import { TomorrowSummary } from "./tomorrow-summary";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
// Thursday 20 August 2026 in the seed zone: 2026-08-19T14:00Z to 2026-08-20T14:00Z.
const bounds = zonedDayBounds("2026-08-20", TZ);
const emptyBrief: TomorrowBrief = {
  dayKey: "2026-08-20",
  bounds,
  sleep: null,
  firstCommitment: null,
  commitments: 0,
  preparationSteps: 0,
  occurrences: 0,
  travel: null
};
const fullBrief: TomorrowBrief = {
  ...emptyBrief,
  sleep: {
    startsAt: at("2026-08-19T12:00:00.000Z"),
    wakeAt: at("2026-08-19T20:30:00.000Z"),
    minutes: 510,
    startsBeforeDay: true
  },
  firstCommitment: {
    id: "dentist",
    title: "Dentist",
    startsAt: at("2026-08-19T23:00:00.000Z"),
    startsBeforeDay: false
  },
  commitments: 2,
  preparationSteps: 1,
  occurrences: 3,
  travel: { commitments: 1, places: ["Campus"] }
};

describe("TomorrowSummary", () => {
  it("names the night, the first fixed commitment, and what else lands", () => {
    render(<TomorrowSummary brief={fullBrief} timezone={TZ} />);
    expect(screen.getByText("Sleep from 10:00 pm tonight, planned wake 6:30 am · 8.5h")).toBeTruthy();
    expect(screen.getByText("First: Dentist at 9:00 am")).toBeTruthy();
    const chips = screen.getByRole("list", { name: "What lands tomorrow" });
    expect([...chips.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "2 commitments",
      "1 preparation step",
      "3 recurring windows",
      "Travel to Campus"
    ]);
  });

  it("says plainly when tomorrow holds nothing, and drops the chip strip rather than showing zeroes", () => {
    render(<TomorrowSummary brief={emptyBrief} timezone={TZ} />);
    expect(screen.getByText("No sleep plan reaches tomorrow morning yet.")).toBeTruthy();
    expect(screen.getByText("Nothing fixed tomorrow.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "What lands tomorrow" })).toBeNull();
  });

  it("marks a night already begun and a commitment that runs in over midnight as coming from the day before", () => {
    render(
      <TomorrowSummary
        brief={{
          ...fullBrief,
          sleep: { ...fullBrief.sleep!, startsBeforeDay: false, startsAt: at("2026-08-20T02:00:00.000Z") },
          firstCommitment: { ...fullBrief.firstCommitment!, title: "Night shift", startsBeforeDay: true }
        }}
        timezone={TZ}
      />
    );
    expect(screen.getByText("Sleep 12:00 pm to 6:30 am · 8.5h")).toBeTruthy();
    expect(screen.getByText("First: Night shift, already under way from 9:00 am")).toBeTruthy();
  });
});
