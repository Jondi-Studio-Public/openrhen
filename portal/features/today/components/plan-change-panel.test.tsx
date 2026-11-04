// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredCommitment } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { PlanChangePanel } from "./plan-change-panel";

const disruption: StoredCommitment = {
  id: "disruption-1",
  title: "Drive Mum to the shops",
  startsAt: "2026-08-18T09:30:00.000Z",
  endsAt: "2026-08-18T11:00:00.000Z",
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  origin: "disruption",
  disruptionSource: "family",
  landedAt: "2026-08-18T09:30:00.000Z"
};

const timezone = "Australia/Sydney";

/**
 * jsdom does not run the browser's native open-on-click behaviour for `<summary>`, so opening the
 * disclosure in a test means setting `open` directly and firing the `toggle` event the component's
 * `onToggle` handler listens for — the same event the real browser dispatches.
 */
function openPanel(container: HTMLElement) {
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("PlanChangePanel", () => {
  it("renders nothing when there is no disruption to explain", () => {
    const { container } = render(<PlanChangePanel disruption={null} timezone={timezone} />);
    expect(container.innerHTML).toBe("");
  });

  it("fetches on first open and lists moved, dropped, added and a bedtime shift", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          available: true,
          moved: [
            {
              kind: "action",
              targetId: "a-1",
              title: "Deep work",
              fromStartsAt: "2026-08-18T04:00:00.000Z",
              toStartsAt: "2026-08-18T06:30:00.000Z",
              deltaMinutes: 150
            }
          ],
          dropped: [{ kind: "action", targetId: "a-2", title: "Gym", startsAt: "2026-08-18T07:00:00.000Z" }],
          added: [{ kind: "action", targetId: "a-3", title: "Errand", startsAt: "2026-08-18T08:00:00.000Z" }],
          sleepShiftMinutes: 35,
          newlyDisplaced: []
        })
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PlanChangePanel disruption={disruption} timezone={timezone} />);
    expect(fetchMock).not.toHaveBeenCalled();
    openPanel(container);
    expect(fetchMock).toHaveBeenCalledWith("/api/planning/changes?disruptionId=disruption-1");
    await vi.waitFor(() => expect(screen.getByText(/Deep work/)).toBeTruthy());
    expect(screen.getByText(/Deep work.*\+150 min/s)).toBeTruthy();
    expect(screen.getByText("Gym — dropped")).toBeTruthy();
    expect(screen.getByText(/Errand — added at/)).toBeTruthy();
    expect(screen.getByText("Bedtime moves 35 min later")).toBeTruthy();
  });

  it("shows the unavailable message when the earlier plan is no longer stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            available: false,
            moved: [],
            dropped: [],
            added: [],
            sleepShiftMinutes: 0,
            newlyDisplaced: []
          })
      })
    );
    const { container } = render(<PlanChangePanel disruption={disruption} timezone={timezone} />);
    openPanel(container);
    await vi.waitFor(() =>
      expect(screen.getByText("The earlier plan is no longer stored, so no comparison is available.")).toBeTruthy()
    );
  });
});
