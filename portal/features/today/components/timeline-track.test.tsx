// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { laneLayout, MIN_BLOCK_PX } from "@/features/today/day-layout";
import { groupCrampedRuns, type DayPlan, type DayPlanItem } from "@/features/today/day-plan";
import { zonedDayBounds } from "@/features/today/local-datetime";
import { TimelineTrack, locationColour, withJourneys } from "./timeline-track";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
const bounds = zonedDayBounds("2026-08-19", TZ);
const NOW = at("2026-08-19T00:00:00.000Z"); // 10:00 am local
const HOUR_PX = 60;

const item = (overrides: Partial<DayPlanItem> & Pick<DayPlanItem, "id" | "kind" | "title">): DayPlanItem => ({
  source: "fixed",
  entityId: overrides.id,
  startsAt: at("2026-08-19T04:00:00.000Z"),
  endsAt: at("2026-08-19T05:00:00.000Z"),
  clippedStart: false,
  clippedEnd: false,
  ...overrides
});

const plan: DayPlan = {
  bounds,
  nowAt: NOW,
  items: [
    item({ id: "c", kind: "commitment", title: "Dentist", subtitle: "Town" }),
    item({
      id: "n",
      kind: "next_fit",
      source: "engine",
      title: "Next fit: Receipts",
      marker: true,
      startsAt: at("2026-08-19T09:00:00.000Z"),
      endsAt: at("2026-08-19T09:00:00.000Z")
    })
  ],
  reserved: [
    item({
      id: "r",
      kind: "reserved",
      source: "reserved",
      title: "Reconcile",
      startsAt: at("2026-08-19T06:00:00.000Z"),
      endsAt: at("2026-08-19T06:30:00.000Z"),
      deadlineAt: at("2026-08-21T06:00:00.000Z"),
      minutes: 30
    })
  ],
  backgrounds: [{ id: "elapsed", kind: "elapsed", startsAt: bounds.startsAt, endsAt: NOW }],
  lines: [{ id: "horizon", kind: "horizon", at: at("2026-08-19T12:00:00.000Z"), label: "Daily horizon" }],
  locations: [],
  waits: [],
  untimed: [{ id: "u", kind: "action", title: "Read chapter 3", minutes: 30, reason: "Next in the engine's ranking" }],
  displaced: [],
  calculatedAt: NOW
};

/**
 * The track is handed its geometry rather than working it out, so a test has to do what the day
 * timeline does first: keep the windows out of the blocks, fold the cramped runs, lay out each lane,
 * and settle on a height for the canvas.
 */
function renderTrack(overrides: Partial<Parameters<typeof TimelineTrack>[0]> = {}) {
  const source = overrides.plan ?? plan;
  const blocks = groupCrampedRuns(
    source.items.filter((entry) => !entry.marker && !entry.window),
    HOUR_PX,
    MIN_BLOCK_PX
  );
  return render(
    <TimelineTrack
      plan={source}
      timezone={TZ}
      pixelsPerHour={HOUR_PX}
      height={1440}
      showReserved
      onSelect={() => {}}
      timedLane={laneLayout(blocks, source.bounds, HOUR_PX)}
      reservedLane={laneLayout(source.reserved, source.bounds, HOUR_PX)}
      blocks={blocks}
      {...overrides}
    />
  );
}

describe("TimelineTrack under a crop", () => {
  it("writes a block's title just below the crop and counts its lines from there", () => {
    // Dentist runs 2 to 3 pm: 840px down, 60px tall. With the top 870px cropped off, 30px of it is seen.
    renderTrack({ visibleFrom: 870 });
    const block = screen.getByRole("button", { name: /^Dentist, / });
    expect(block.style.paddingTop).toBe("32px");
    expect(block.textContent).not.toContain("Town");
  });

  it("leaves a block the crop does not reach alone", () => {
    renderTrack({ visibleFrom: 600 });
    const block = screen.getByRole("button", { name: /^Dentist, / });
    expect(block.style.paddingTop).toBe("");
    expect(block.textContent).toContain("Town");
  });
});

describe("TimelineTrack", () => {
  it("draws the blocks with their meta, the reservation lane, the markers and the untimed strip", () => {
    const { container } = renderTrack();
    const dentist = screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" });
    expect(dentist.querySelector(".day-timeline-block-meta")!.textContent).toBe("Town");
    expect(screen.getByRole("button", { name: "Reserved: Reconcile, 4:00 pm to 4:30 pm" }).textContent).toContain(
      "reserved by"
    );
    expect(screen.getByRole("button", { name: "Next fit: Receipts, 7:00 pm" })).toBeTruthy();
    // Ten in the morning is the first clear stretch, so the strip settles on the now-line.
    expect((container.querySelector(".day-timeline-untimed") as HTMLElement).style.top).toBe("600px");
    expect(container.querySelector(".day-timeline-chip")!.textContent).toBe("Read chapter 3 · 30 min");
  });

  it("names the leave-by time on a travel block, from the block's own start", () => {
    const travelPlan: DayPlan = {
      ...plan,
      items: [
        item({
          id: "t",
          kind: "travel",
          source: "engine",
          title: "Drive to Campus",
          subtitle: "18 min",
          // 45 minutes, clear of the meta line's minimum block height at 60px/hour.
          startsAt: at("2026-08-19T03:15:00.000Z"), // 1:15 pm local
          endsAt: at("2026-08-19T04:00:00.000Z") // 2:00 pm local
        })
      ],
      // The reserved lane's own block reuses the same meta class name; drop it so the query below is
      // unambiguous rather than picking up whichever block happens to render first.
      reserved: []
    };
    const { container } = renderTrack({ plan: travelPlan });
    expect(container.querySelector(".day-timeline-block-meta")!.textContent).toBe("18 min · Leave by 1:15 pm");
  });

  it("styles a leave-by and a start-by marker by their kind and urgency", () => {
    const markerPlan: DayPlan = {
      ...plan,
      items: [
        ...plan.items,
        item({
          id: "lb",
          kind: "leave_by",
          source: "engine",
          title: "Leave by 13:38 for Dentist",
          marker: true,
          startsAt: at("2026-08-19T03:38:00.000Z"),
          endsAt: at("2026-08-19T03:38:00.000Z")
        }),
        item({
          id: "sb",
          kind: "start_by",
          source: "engine",
          title: "Start Wash by 7:30 pm",
          marker: true,
          urgency: "missed",
          startsAt: at("2026-08-19T09:30:00.000Z"),
          endsAt: at("2026-08-19T09:30:00.000Z")
        })
      ]
    };
    const { container } = renderTrack({ plan: markerPlan });
    expect(container.querySelector(".day-timeline-marker-leave_by")).toBeTruthy();
    const startByMarker = container.querySelector(".day-timeline-marker-start_by")!;
    expect(startByMarker.className).toContain("missed");
    // The title already names the time; the marker does not say it twice.
    expect(startByMarker.textContent).toBe("Start Wash by 7:30 pm");
    expect(screen.getByRole("button", { name: /Leave by 13:38 for Dentist/ })).toBeTruthy();
  });

  it("draws a commitment's leave-by as a journey bar on the block, with Leave as its first line, not a chip", () => {
    const journeyPlan: DayPlan = {
      ...plan,
      items: [
        ...plan.items,
        item({
          id: "leave_by:c",
          kind: "leave_by",
          source: "engine",
          entityId: "c",
          title: "Leave by 13:30 for Dentist",
          subtitle: "usually 25 min · allowing 30",
          marker: true,
          startsAt: at("2026-08-19T03:30:00.000Z"), // 1:30 pm local, half an hour before the 2:00 pm block
          endsAt: at("2026-08-19T03:30:00.000Z")
        })
      ]
    };
    const { container } = renderTrack({ plan: journeyPlan });
    expect(container.querySelector(".day-timeline-marker-leave_by")).toBeNull();
    const dentist = screen.getByRole("button", {
      name: "Dentist, 2:00 pm to 3:00 pm, leave 1:30 pm, usually 25 min · allowing 30"
    });
    expect(dentist.firstElementChild!.textContent).toBe("Leave 1:30 pm");
    const bar = container.querySelector<HTMLElement>("[data-testid='day-timeline-journey']")!;
    // Thirty minutes at 60px an hour, ending where the block begins.
    expect(bar.style.top).toBe("-30px");
    expect(bar.style.height).toBe("30px");
    expect(bar.closest("li")!.className).toContain("has-journey");
  });

  it("moves a pushed block's journey bar with the block instead of stretching it over the blocks between", () => {
    const leaveBy = item({
      id: "leave_by:c",
      kind: "leave_by",
      source: "engine",
      entityId: "c",
      title: "Leave by 13:30 for Dentist",
      marker: true,
      startsAt: at("2026-08-19T03:30:00.000Z"),
      endsAt: at("2026-08-19T03:30:00.000Z")
    });
    const dentist = plan.items.find((entry) => entry.id === "c")!;
    // Three minute-long blocks just before the 2:00 pm Dentist, each drawn taller than it lasts, push it down.
    const crowd = [0, 1, 2].map((index) =>
      item({
        id: `crowd-${index}`,
        kind: "session",
        title: `Session ${index}`,
        startsAt: at(`2026-08-19T03:5${index * 3}:00.000Z`),
        endsAt: at(`2026-08-19T03:5${index * 3 + 1}:00.000Z`)
      })
    );
    const { container } = renderTrack({ plan: { ...plan, items: [dentist, ...crowd, leaveBy], reserved: [] } });
    const bar = container.querySelector<HTMLElement>("[data-testid='day-timeline-journey']")!;
    // Still thirty minutes long, ending where the block is drawn, however far down that is.
    expect(bar.style.top).toBe("-30px");
    expect(bar.style.height).toBe("30px");
  });

  it("puts Leave on the title's line when the block has no room for three lines", () => {
    const leaveBy = item({
      id: "leave_by:c",
      kind: "leave_by",
      source: "engine",
      entityId: "c",
      title: "Leave by 13:30 for Dentist",
      marker: true,
      startsAt: at("2026-08-19T03:30:00.000Z"),
      endsAt: at("2026-08-19T03:30:00.000Z")
    });
    // 45 minutes is 45px at 60px an hour: room for a title and its meta, not for a Leave line as well.
    const short = item({
      id: "c",
      kind: "commitment",
      title: "Dentist",
      subtitle: "Town",
      endsAt: at("2026-08-19T04:45:00.000Z")
    });
    const { container } = renderTrack({ plan: { ...plan, items: [short, leaveBy], reserved: [] } });
    const block = container.querySelector(".day-timeline-block")!;
    expect(block.querySelector(".day-timeline-block-title")!.textContent).toBe("Leave 1:30 pm · Dentist");
    expect(block.querySelector(".day-timeline-block-meta")!.textContent).toBe("Town");
    expect(block.children).toHaveLength(2);
  });

  it("takes the engine's legs inside a journey into the bar, and leaves a leg outside every journey a block", () => {
    const leg = (id: string, title: string, start: string, end: string) =>
      item({ id, kind: "travel", source: "engine", title, subtitle: "25 min", startsAt: at(start), endsAt: at(end) });
    const legsPlan: DayPlan = {
      ...plan,
      items: [
        ...plan.items,
        item({
          id: "leave_by:c",
          kind: "leave_by",
          source: "engine",
          entityId: "c",
          title: "Leave by 13:30 for Dentist",
          marker: true,
          startsAt: at("2026-08-19T03:30:00.000Z"),
          endsAt: at("2026-08-19T03:30:00.000Z")
        }),
        leg("to-dentist", "Drive to Dentist", "2026-08-19T03:30:00.000Z", "2026-08-19T03:55:00.000Z"),
        leg("home", "Drive to Home", "2026-08-19T05:10:00.000Z", "2026-08-19T05:35:00.000Z")
      ],
      reserved: []
    };
    const { items, journeys } = withJourneys(
      legsPlan,
      legsPlan.items.filter((entry) => !entry.marker && !entry.window)
    );
    expect(items.map((entry) => entry.id)).toEqual(["c", "home"]);
    expect(journeys.get("c")!.legs.map((entry) => entry.id)).toEqual(["to-dentist"]);
    const blocks = groupCrampedRuns(items, HOUR_PX, MIN_BLOCK_PX);
    renderTrack({ plan: legsPlan, blocks, timedLane: laneLayout(blocks, legsPlan.bounds, HOUR_PX) });
    expect(
      screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm, leave 1:30 pm, Drive to Dentist (25 min)" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Drive to Dentist/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Drive to Home/ })).toBeTruthy();
  });

  it("keeps a leave-by as a marker when its commitment is not drawn as a block of its own", () => {
    const orphanPlan: DayPlan = {
      ...plan,
      items: [
        item({
          id: "leave_by:elsewhere",
          kind: "leave_by",
          source: "engine",
          entityId: "elsewhere",
          title: "Leave by 23:40 for Early start",
          marker: true,
          startsAt: at("2026-08-19T13:40:00.000Z"),
          endsAt: at("2026-08-19T13:40:00.000Z")
        })
      ]
    };
    const { container } = renderTrack({ plan: orphanPlan });
    expect(container.querySelector(".day-timeline-marker-leave_by")).toBeTruthy();
    expect(container.querySelector("[data-testid='day-timeline-journey']")).toBeNull();
  });

  it("gives a block the colour of the stay it happens in, for the phone's left edge", () => {
    const placedPlan: DayPlan = {
      ...plan,
      locations: [
        {
          id: "stay:town",
          locationId: "ctx-town",
          label: "Town",
          startsAt: at("2026-08-19T03:00:00.000Z"),
          endsAt: at("2026-08-19T06:00:00.000Z")
        }
      ]
    };
    const { container } = renderTrack({ plan: placedPlan });
    const dentist = screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" }).closest("li")!;
    expect(dentist.className).toContain("has-place");
    expect(dentist.style.getPropertyValue("--dt-place")).toBe(locationColour("ctx-town"));
    expect(container.querySelectorAll(".has-place")).toHaveLength(1);
  });

  it("settles a window's label below the blocks drawn over its band, and leaves it out of a crowded week column", () => {
    const window = item({
      id: "w",
      kind: "occurrence",
      title: "Stretch",
      subtitle: "Morning window",
      window: true,
      // 1:00 pm to 3:30 pm local. The Call (1:00-1:45 pm) and the Dentist (2:00-3:00 pm) cover all of
      // it but the last half hour, and the quarter hour between them is too short for the chip.
      startsAt: at("2026-08-19T03:00:00.000Z"),
      endsAt: at("2026-08-19T05:30:00.000Z")
    });
    const covering = item({
      id: "early",
      kind: "commitment",
      title: "Call",
      startsAt: at("2026-08-19T03:00:00.000Z"),
      endsAt: at("2026-08-19T03:45:00.000Z")
    });
    const windowPlan: DayPlan = { ...plan, items: [covering, ...plan.items, window], reserved: [] };
    const { container, unmount } = renderTrack({ plan: windowPlan });
    // The band starts at 780px; the chip clears the Call (to 825px), would clip the Dentist (840-900px),
    // and settles at 901px, 121px down its band.
    expect(container.querySelector<HTMLElement>(".day-timeline-window-label")!.style.top).toBe("121px");
    unmount();

    // A window wholly under blocks has no clear stretch: the day view keeps the chip at its top, the
    // dense week column draws the band alone, titled, rather than a chip showing through the gaps.
    const crowded: DayPlan = {
      ...windowPlan,
      items: [{ ...covering, endsAt: at("2026-08-19T05:30:00.000Z") }, window]
    };
    const day = renderTrack({ plan: crowded });
    expect(day.container.querySelector<HTMLElement>(".day-timeline-window-label")!.style.top).toBe("2px");
    day.unmount();
    const week = renderTrack({ plan: crowded, dense: true });
    expect(week.container.querySelector(".day-timeline-window-label")).toBeNull();
    expect(week.container.querySelector(".day-timeline-window")!.getAttribute("title")).toBe(
      "Stretch, 1:00 pm to 3:30 pm"
    );
  });

  it("draws a soft cadence placement dashed in the reserved lane, only while showReserved is on", () => {
    const softPlan: DayPlan = {
      ...plan,
      reserved: [
        ...plan.reserved,
        item({
          id: "soft-gym",
          kind: "soft",
          source: "engine",
          title: "Gym",
          subtitle: "2 of 3 fit this week",
          startsAt: at("2026-08-19T07:00:00.000Z"),
          endsAt: at("2026-08-19T07:30:00.000Z")
        })
      ]
    };
    const { container: shown } = renderTrack({ plan: softPlan, showReserved: true });
    const softBlock = shown.querySelector(".day-timeline-reserved-block.soft")!;
    expect(softBlock).toBeTruthy();
    expect(softBlock.querySelector(".day-timeline-block-meta")!.textContent).toBe("2 of 3 fit this week");
    expect(screen.getByRole("button", { name: "Cadence room: Gym, 5:00 pm to 5:30 pm" })).toBeTruthy();

    const { container: hidden } = renderTrack({ plan: softPlan, showReserved: false });
    expect(hidden.querySelector(".day-timeline-reserved-block.soft")).toBeNull();
    expect(hidden.querySelector(".day-timeline-reserved")).toBeNull();
  });

  it("drops every meta line when dense, however much room the block has for one", () => {
    // An hour is 60 px, comfortably over the height a second line normally needs.
    const { container } = renderTrack({ dense: true });
    expect(container.querySelector(".day-timeline-block-meta")).toBeNull();
    expect(screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" }).textContent).toBe("Dentist");
    expect(screen.getByRole("button", { name: "Reserved: Reconcile, 4:00 pm to 4:30 pm" }).textContent).toBe(
      "Reconcile"
    );
    // Only the second line goes: the block is still where and how tall it was.
    const row = container.querySelector(".day-timeline-item") as HTMLElement;
    expect([row.style.top, row.style.height]).toEqual(["840px", "60px"]);
  });

  it("leaves out the untimed strip when the surface places the chips itself", () => {
    const { container } = renderTrack({ showUntimed: false });
    expect(container.querySelector(".day-timeline-untimed")).toBeNull();
    expect(container.querySelector(".day-timeline-chip")).toBeNull();
    // Nothing else about the track depends on it.
    expect(screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" })).toBeTruthy();
    expect(screen.getByTestId("day-timeline-now").style.top).toBe("600px");
  });

  it("stretches to the height it is given without moving what the clock puts where", () => {
    // A grid of days shares one height — the tallest day's — which this day has no use for itself.
    const { container } = renderTrack({ height: 2000 });
    expect((container.querySelector(".day-timeline-track") as HTMLElement).style.height).toBe("2000px");
    const rules = [...container.querySelectorAll<HTMLElement>(".day-timeline-rule")];
    expect(rules).toHaveLength(24);
    expect([rules[0]!.style.top, rules[23]!.style.top]).toEqual(["0px", "1380px"]);
    // The blocks are measured against the day's own bounds, not against the borrowed height.
    expect((container.querySelector(".day-timeline-item") as HTMLElement).style.top).toBe("840px");
  });
});
