// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { periodFor } from "@/features/review/planning-focus-period";

const now = new Date("2026-08-30T00:00:00.000Z");
const seed = createSeedState(now);

const baseContext = {
  ready: true,
  capacityEnvelopes: [{ adjustedCapacityMinutes: 600 }],
  saveEntityCommand: vi.fn()
};

let context: typeof baseContext & { state: typeof seed };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

// Imported after the mock, per vitest's hoisting of vi.mock above imports.
import ReviewFocusPage from "./page";

describe("Review focus page", () => {
  it("links back to Review and lists only undated active projects, checkable for each period", () => {
    context = { ...baseContext, state: seed };
    render(<ReviewFocusPage />);
    expect(screen.getByRole("link", { name: "← Review" }).getAttribute("href")).toBe("/review");
    // networking-assignment carries dated deadlines and must not appear; clean-room has none.
    expect(screen.queryByText("Submit Networking Assignment 2")).toBeNull();
    const weekCard = screen.getByText("This week").closest("details")!;
    const monthCard = screen.getByText("This month").closest("details")!;
    expect(within(weekCard).getByLabelText("Reset and clean my room")).toBeTruthy();
    expect(within(monthCard).getByLabelText("Reset and clean my room")).toBeTruthy();
  });

  it("saves the weekly selection through saveEntityCommand when a project is checked", async () => {
    context = { ...baseContext, state: seed, saveEntityCommand: vi.fn().mockResolvedValue(undefined) };
    render(<ReviewFocusPage />);
    const weekCard = screen.getByText("This week").closest("details")!;
    fireEvent.click(within(weekCard).getByLabelText("Reset and clean my room"));
    fireEvent.click(within(weekCard).getByRole("button", { name: "Save this week focus" }));
    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
    const command = context.saveEntityCommand.mock.calls[0]![0];
    expect(command).toMatchObject({
      type: "save_entity",
      entityType: "planning_focus",
      entity: { kind: "weekly", projectIds: ["clean-room"] }
    });
    expect(await screen.findByText("Weekly focus saved.")).toBeTruthy();
  });

  it("starts this week from last week's focus until this week has its own", () => {
    const thisWeek = periodFor("weekly", new Date(), seed.settings.timezone);
    const lastStart = new Date(new Date(`${thisWeek.start}T00:00:00Z`).getTime() - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const last = {
      id: "focus-last",
      version: 1,
      kind: "weekly" as const,
      periodStart: lastStart,
      periodEnd: thisWeek.start,
      projectIds: ["clean-room"]
    };
    context = { ...baseContext, state: { ...seed, planningFocus: [last] } };
    render(<ReviewFocusPage />);
    const weekCard = screen.getByText("This week").closest("details")!;
    expect((within(weekCard).getByLabelText("Reset and clean my room") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/starts from last week's focus/)).toBeTruthy();
  });

  it("seeds from last week's focus when the plan loads after the first render", () => {
    const thisWeek = periodFor("weekly", new Date(), seed.settings.timezone);
    const lastStart = new Date(new Date(`${thisWeek.start}T00:00:00Z`).getTime() - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const last = {
      id: "focus-last",
      version: 1,
      kind: "weekly" as const,
      periodStart: lastStart,
      periodEnd: thisWeek.start,
      projectIds: ["clean-room"]
    };
    context = { ...baseContext, ready: false, state: { ...seed, planningFocus: [] } };
    const { rerender } = render(<ReviewFocusPage />);
    context = { ...baseContext, ready: true, state: { ...seed, planningFocus: [last] } };
    rerender(<ReviewFocusPage />);
    const weekCard = screen.getByText("This week").closest("details")!;
    expect((within(weekCard).getByLabelText("Reset and clean my room") as HTMLInputElement).checked).toBe(true);
  });

  it("warns when the selected focus needs more effort than the forecast has available", () => {
    // The page resolves "this week" from the real clock (`new Date()`), same as the component does,
    // so the fixture's stored record has to land on the same boundary to be picked up on render.
    const weeklyPeriod = periodFor("weekly", new Date(), seed.settings.timezone);
    context = {
      ...baseContext,
      state: {
        ...seed,
        planningFocus: [
          {
            id: "focus-week",
            version: 1,
            kind: "weekly" as const,
            periodStart: weeklyPeriod.start,
            periodEnd: weeklyPeriod.end,
            projectIds: ["clean-room"]
          }
        ]
      },
      capacityEnvelopes: [{ adjustedCapacityMinutes: 10 }]
    };
    render(<ReviewFocusPage />);
    expect(screen.getByText(/needs about 1 hours, more than the 0 discounted hours available/)).toBeTruthy();
  });
});
