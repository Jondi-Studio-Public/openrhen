// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { BoundaryDirective } from "@/features/now/now-model";
import { BoundaryPanel } from "./boundary-panel";

// 20:30 in the seed zone on 18 August 2026 (AEST, UTC+10).
const now = new Date("2026-08-18T10:30:00.000Z");
const state: PortalState = createSeedState(now);
const directive: BoundaryDirective = {
  kind: "boundary",
  title: "Nothing fits before today's horizon",
  recommendedMinutes: 0,
  boundaryAt: "2026-08-18T12:00:00.000Z",
  boundaryKind: "daily_horizon",
  nextFit: {
    kind: "action",
    targetId: "a1",
    title: "Draft the report",
    recommendedMinutes: 45,
    at: "2026-08-18T22:00:00.000Z"
  }
};
const props = {
  state,
  now,
  timezone: "Australia/Sydney",
  saving: false,
  explanation: "Too little time remains before the horizon.",
  evidence: ["Draft the report needs 30 minutes; 15 remain"],
  saveEntityCommand: vi.fn().mockResolvedValue(undefined)
};

describe("BoundaryPanel", () => {
  it("names the boundary in the user's timezone and the first thing that fits after it", () => {
    render(<BoundaryPanel {...props} directive={directive} isDailyHorizon />);
    expect(screen.getByText("Nothing fits before today's planning horizon · 10:00 pm")).toBeTruthy();
    expect(screen.getByText("Draft the report").closest("p")?.textContent).toBe(
      "Next fit: Draft the report for 45 minutes at 8:00 am on Wed, 19 Aug."
    );
    expect(screen.getByText("Why nothing fits before then")).toBeTruthy();
  });

  it("offers to work later tonight only when the boundary is the daily horizon, through the daily-plan override", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <BoundaryPanel {...props} saveEntityCommand={save} directive={directive} isDailyHorizon />
    );
    fireEvent.click(screen.getByRole("button", { name: "+2 hours" }));
    const command = save.mock.calls[0]![0];
    expect(command.entityType).toBe("daily_plan");
    expect(command.entity.localDate).toBe("2026-08-18");
    // Two hours past the 22:00 horizon, which is still ahead of now.
    expect(command.entity.horizonOverrideAt).toBe("2026-08-18T14:00:00.000Z");
    unmount();
    render(
      <BoundaryPanel
        {...props}
        directive={{ ...directive, boundaryKind: "commitment", boundaryTitle: "Dinner and reset" }}
        isDailyHorizon={false}
      />
    );
    expect(screen.getByText(/Nothing fits until .*, after Dinner and reset/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+2 hours" })).toBeNull();
    unmount();
    // Protection ENDS at the boundary: the wording must not claim the commitment starts there.
    render(
      <BoundaryPanel
        {...props}
        directive={{ ...directive, boundaryKind: "commitment", boundaryTitle: "College Class", boundaryEdge: "end" }}
        isDailyHorizon={false}
      />
    );
    expect(screen.getByText(/Nothing fits until .*, after College Class/)).toBeTruthy();
  });

  it("states when things fit again once, not in the line and the footer", () => {
    render(
      <BoundaryPanel
        {...props}
        directive={{ ...directive, boundaryKind: "commitment", boundaryTitle: "Craig Cooking" }}
        isDailyHorizon={false}
      />
    );
    expect(screen.getByText(/Nothing fits until 8:00 am on Wed, 19 Aug, after Craig Cooking/)).toBeTruthy();
    expect(screen.getByText("Draft the report").closest("p")?.textContent).toBe(
      "Next fit: Draft the report for 45 minutes."
    );
  });

  it("offers one tap to say you are at the place the blocked action needs", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <BoundaryPanel
        {...props}
        saveEntityCommand={save}
        directive={{ ...directive, boundaryKind: "commitment", boundaryTitle: "Craig Cooking" }}
        isDailyHorizon={false}
        blockedPlaces={[{ id: "shops", name: "shops", actionTitle: "Buy supplies" }]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "I am at shops" }));
    expect(save.mock.calls[0]![0].entity.currentSituation.locationId).toBe("shops");
  });

  it("extends from now once the horizon has already passed", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <BoundaryPanel
        {...props}
        now={new Date("2026-08-18T13:00:00.000Z")}
        saveEntityCommand={save}
        directive={directive}
        isDailyHorizon
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "+1 hour" }));
    expect(save.mock.calls[0]![0].entity.horizonOverrideAt).toBe("2026-08-18T14:00:00.000Z");
  });

  it("stops an extension at the next wake instead of running into the day that begins there", () => {
    // seed-zone, 05:30 on 18 August with a 00:30 end and a 07:00 wake: the day that began yesterday is
    // still live, so "+2 hours" and "+3 hours" would both cross the 07:00 wake into the new day.
    const overnight: PortalState = {
      ...state,
      settings: { ...state.settings, planningHorizonEnd: "00:30", preferredWakeTime: "07:00" }
    };
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <BoundaryPanel
        {...props}
        state={overnight}
        now={new Date("2026-08-17T19:30:00.000Z")}
        saveEntityCommand={save}
        directive={{ ...directive, boundaryAt: "2026-08-17T14:30:00.000Z" }}
        isDailyHorizon
      />
    );
    expect(screen.queryByRole("button", { name: "+2 hours" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+3 hours" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "until 7:00 am" }));
    expect(save.mock.calls[0]![0].entity.horizonOverrideAt).toBe("2026-08-17T21:00:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "+1 hour" }));
    expect(save.mock.calls[1]![0].entity.horizonOverrideAt).toBe("2026-08-17T20:30:00.000Z");
  });

  it("collapses the options into one that ends at the wake when the wake is minutes away", () => {
    const overnight: PortalState = {
      ...state,
      settings: { ...state.settings, planningHorizonEnd: "00:30", preferredWakeTime: "07:00" }
    };
    render(
      <BoundaryPanel
        {...props}
        state={overnight}
        now={new Date("2026-08-17T20:59:30.000Z")}
        directive={{ ...directive, boundaryAt: "2026-08-17T14:30:00.000Z" }}
        isDailyHorizon
      />
    );
    expect(screen.getAllByRole("button", { name: /^until / })).toHaveLength(1);
  });

  it("says when nothing fits after the boundary either", () => {
    render(<BoundaryPanel {...props} directive={{ ...directive, nextFit: null }} isDailyHorizon={false} />);
    expect(screen.getByText("Nothing after it fits inside the forecast either.")).toBeTruthy();
  });
});
