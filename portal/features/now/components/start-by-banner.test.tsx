// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { StartByWarning } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import { StartByBanner } from "./start-by-banner";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const timezone = "Australia/Sydney";

// `state.commitments[0]` ("Dinner and reset") starts 120 minutes after `now`, i.e. 22:00 local.
const anchorId = state.commitments[0]!.id;

const soonWarning: StartByWarning = {
  stepId: "step-wash",
  anchorId,
  anchorTitle: "Dinner and reset",
  title: "the wash",
  startBy: "2026-08-18T10:15:00.000Z", // 20:15 local
  status: "soon"
};

describe("StartByBanner", () => {
  it("renders nothing when there are no warnings", () => {
    const { container } = render(<StartByBanner warnings={[]} state={state} timezone={timezone} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a soon warning naming the step, its start-by time, and the anchor with its own time", () => {
    render(<StartByBanner warnings={[soonWarning]} state={state} timezone={timezone} />);
    expect(screen.getByText(/Start the wash by 8:15 pm — for Dinner and reset at 10:00 pm/)).toBeTruthy();
  });

  it("shows the missed form once startBy has passed", () => {
    const missedWarning: StartByWarning = { ...soonWarning, status: "missed" };
    render(<StartByBanner warnings={[missedWarning]} state={state} timezone={timezone} />);
    expect(screen.getByText(/Missed: start the wash by 8:15 pm — for Dinner and reset at 10:00 pm/)).toBeTruthy();
  });

  it("renders one line per warning, in the order given", () => {
    const second: StartByWarning = { ...soonWarning, stepId: "step-lunch", title: "lunch" };
    render(<StartByBanner warnings={[soonWarning, second]} state={state} timezone={timezone} />);
    expect(screen.getByText(/Start the wash by/)).toBeTruthy();
    expect(screen.getByText(/Start lunch by/)).toBeTruthy();
  });
});
