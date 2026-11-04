// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { periodFor } from "@/features/review/planning-focus-period";

const now = new Date("2026-10-28T09:00:00+11:00");
freezeClock(now);
const seed = createSeedState(now);
const week = periodFor("weekly", now, seed.settings.timezone);

let context: { state: typeof seed; forecasts: never[]; ready: boolean };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

import { ReviewDueLine } from "./review-due-line";

const undated = () => {
  const { internalDeadlineAt: _i, externalDeadlineAt: _e, ...rest } = seed.projects[0]!;
  return { ...rest, lastWorkedAt: now.toISOString() } as (typeof seed.projects)[number];
};

describe("ReviewDueLine", () => {
  it("says how many steps are left and links to the review", () => {
    context = { state: { ...seed, projects: [undated()], planningFocus: [] }, forecasts: [], ready: true };
    render(<ReviewDueLine />);
    expect(screen.getByText("Weekly review: 1 step left.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open review" }).getAttribute("href")).toBe("/review");
  });

  it("is gone once the week is reviewed", () => {
    const record = {
      id: "w",
      kind: "weekly" as const,
      periodStart: week.start,
      periodEnd: week.end,
      projectIds: [],
      reviewedOn: "2026-10-28"
    };
    context = { state: { ...seed, projects: [undated()], planningFocus: [record] }, forecasts: [], ready: true };
    const { container } = render(<ReviewDueLine />);
    expect(container.textContent).toBe("");
  });

  it("shows nothing before the plan has loaded", () => {
    context = { state: seed, forecasts: [], ready: false };
    const { container } = render(<ReviewDueLine />);
    expect(container.textContent).toBe("");
  });
});
