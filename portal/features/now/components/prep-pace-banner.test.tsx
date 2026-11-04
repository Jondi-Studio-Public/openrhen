// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PrepPace } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { PrepPaceBanner } from "./prep-pace-banner";

const openCaptureSheetMock = vi.fn();
vi.mock("@/shared/use-capture-sheet", () => ({
  openCaptureSheet: (...args: unknown[]) => openCaptureSheetMock(...args)
}));

const now = new Date("2026-09-04T00:00:00.000Z");
let context: Record<string, unknown>;
vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => context };
});

const timezone = "Australia/Sydney";

const behind: PrepPace = {
  commitmentId: "commitment-college",
  commitmentTitle: "College Online",
  commitmentStartsAt: "2026-09-04T00:00:00.000Z", // 10:00 am local
  requiredMinutes: 27,
  availableMinutes: 20,
  minutesBehind: 7,
  status: "behind"
};

const tight: PrepPace = {
  ...behind,
  requiredMinutes: 20,
  availableMinutes: 23,
  minutesBehind: 0,
  status: "tight"
};

const onTrack: PrepPace = {
  ...behind,
  requiredMinutes: 15,
  availableMinutes: 60,
  minutesBehind: 0,
  status: "on_track"
};

describe("PrepPaceBanner", () => {
  it("shows the minutes behind and the commitment when the engine reports behind", () => {
    render(<PrepPaceBanner prepPace={behind} timezone={timezone} />);
    expect(screen.getByText(/Behind prep pace/)).toBeTruthy();
    expect(screen.getByText(/7 min behind/)).toBeTruthy();
    expect(screen.getByText(/College Online at 10:00/)).toBeTruthy();
  });

  it("shows the quieter spare-minutes wording when the engine reports tight", () => {
    render(<PrepPaceBanner prepPace={tight} timezone={timezone} />);
    expect(screen.getByText(/Prep is tight/)).toBeTruthy();
    expect(screen.getByText(/3 min spare/)).toBeTruthy();
    expect(screen.queryByText(/Behind prep pace/)).toBeNull();
  });

  it("renders nothing when the engine reports on_track", () => {
    const { container } = render(<PrepPaceBanner prepPace={onTrack} timezone={timezone} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when there is no prepPace at all", () => {
    const { container } = render(<PrepPaceBanner prepPace={undefined} timezone={timezone} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the projected-late wording and names the contact on the Let ... know? button", () => {
    const projectedLate: PrepPace = {
      ...behind,
      projectedArriveAt: "2026-09-04T00:05:00.000Z",
      projectedLateMinutes: 5
    };
    context = {
      state: {
        ...createSeedState(now),
        settings: { ...createSeedState(now).settings, timezone },
        commitments: [
          {
            id: "commitment-college",
            title: "College Online",
            startsAt: behind.commitmentStartsAt,
            endsAt: behind.commitmentStartsAt,
            status: "confirmed",
            contactId: "sam"
          }
        ],
        conditionDefinitions: [{ id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }]
      }
    };
    render(<PrepPaceBanner prepPace={projectedLate} timezone={timezone} />);
    expect(screen.getByText("At this pace you'll arrive ~5 min late")).toBeTruthy();
    expect(screen.queryByText(/Behind prep pace/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Let Sam know?" }));
    expect(openCaptureSheetMock).toHaveBeenCalledWith("disruption", {
      contactId: "sam",
      about: "College Online at 10:00 am",
      reason: "late",
      lateMinutes: 5
    });
  });

  it("keeps today's behind wording, with no button, when projectedLateMinutes is absent", () => {
    render(<PrepPaceBanner prepPace={behind} timezone={timezone} />);
    expect(screen.getByText(/Behind prep pace/)).toBeTruthy();
    expect(screen.queryByText(/arrive ~/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Let someone know?" })).toBeNull();
  });
});
