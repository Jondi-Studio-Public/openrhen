// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import type { DayPlan, DayPlanItem } from "@/features/today/day-plan";
import { zonedDayBounds } from "@/features/today/local-datetime";
import { DayTimeline, locationColour } from "./day-timeline";
import { DayAgendaList } from "./day-agenda-list";

const TZ = "Australia/Sydney";
const at = (value: string) => new Date(value);
const bounds = zonedDayBounds("2026-08-19", TZ);
const NOW = at("2026-08-19T00:00:00.000Z"); // 10:00 am local

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
    item({
      id: "c",
      kind: "commitment",
      title: "Dentist",
      subtitle: "Town",
      halos: [{ startsAt: at("2026-08-19T03:45:00.000Z"), endsAt: at("2026-08-19T04:00:00.000Z") }]
    }),
    item({
      id: "s",
      kind: "session",
      source: "recorded",
      title: "Draft report",
      startsAt: at("2026-08-19T04:30:00.000Z"),
      endsAt: at("2026-08-19T05:30:00.000Z")
    }),
    item({
      id: "d",
      kind: "directive",
      source: "engine",
      title: "Write the intro",
      startsAt: NOW,
      endsAt: at("2026-08-19T01:00:00.000Z"),
      subtitle: "Planned now · 60 min"
    }),
    item({
      id: "plan:a2:2026-08-19T06:30:00.000Z",
      kind: "planned",
      source: "engine",
      title: "Reconcile receipts",
      subtitle: "30 focused min over 30 · At risk · self-set deadline",
      projected: true,
      displaced: true,
      startsAt: at("2026-08-19T06:30:00.000Z"),
      endsAt: at("2026-08-19T07:00:00.000Z")
    }),
    item({
      id: "n",
      kind: "next_fit",
      source: "engine",
      title: "Next fit: Receipts",
      marker: true,
      startsAt: at("2026-08-19T09:00:00.000Z"),
      endsAt: at("2026-08-19T09:00:00.000Z")
    }),
    item({
      id: "sleep",
      kind: "sleep",
      title: "Sleep",
      startsAt: at("2026-08-19T12:00:00.000Z"),
      endsAt: bounds.endsAt,
      clippedEnd: true
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
  backgrounds: [
    { id: "elapsed", kind: "elapsed", startsAt: bounds.startsAt, endsAt: NOW },
    { id: "free", kind: "free", startsAt: NOW, endsAt: at("2026-08-19T04:00:00.000Z") }
  ],
  lines: [
    { id: "horizon", kind: "horizon", at: at("2026-08-19T12:00:00.000Z"), label: "Daily horizon" },
    { id: "gap:x", kind: "gap", at: at("2026-08-19T07:00:00.000Z"), label: "Nothing fits · waiting on an answer" }
  ],
  locations: [
    {
      id: "location:home",
      locationId: "ctx-home",
      label: "Home",
      startsAt: bounds.startsAt,
      endsAt: at("2026-08-19T03:30:00.000Z")
    },
    {
      id: "location:transit",
      locationId: null,
      label: "In transit",
      startsAt: at("2026-08-19T03:30:00.000Z"),
      endsAt: at("2026-08-19T04:00:00.000Z")
    },
    {
      id: "location:campus",
      locationId: "ctx-campus",
      label: "Campus",
      startsAt: at("2026-08-19T04:00:00.000Z"),
      endsAt: bounds.endsAt
    }
  ],
  waits: [],
  untimed: [{ id: "u", kind: "action", title: "Read chapter 3", minutes: 30, reason: "Next in the engine's ranking" }],
  displaced: [],
  calculatedAt: NOW
};

const travel: DayPlanItem = item({
  id: "directive:travel:ctx-campus",
  kind: "travel",
  source: "engine",
  title: "Drive to Campus",
  subtitle: "18 min · then Assessment 2",
  startsAt: at("2026-08-19T03:30:00.000Z"),
  endsAt: at("2026-08-19T03:48:00.000Z"),
  entityId: "ctx-campus",
  minutes: 18,
  mode: "car",
  travelSource: "measured",
  thenTitle: "Assessment 2",
  reason: "The journey to Assessment 2 is protected like its buffer."
});

describe("DayTimeline", () => {
  it("draws an hour gutter, positions blocks by minute arithmetic, and packs overlaps side by side", () => {
    const { container } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const hours = container.querySelectorAll(".day-timeline-hour");
    expect(hours).toHaveLength(24);
    expect(hours[9]!.textContent).toBe("9 am");
    expect((hours[9] as HTMLElement).style.top).toBe("540px");
    expect((container.querySelector(".day-timeline-canvas") as HTMLElement).style.height).toBe("1440px");
    // Dentist 2–3 pm local: 14 h × 60 px.
    const dentist = screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" }).closest("li")!;
    expect(dentist.style.top).toBe("840px");
    expect(dentist.style.height).toBe("60px");
    expect(dentist.style.width).toBe("50%");
    const session = screen.getByRole("button", { name: "Draft report, 2:30 pm to 3:30 pm" }).closest("li")!;
    expect(session.style.left).toBe("50%");
    // The setup halo sits fifteen minutes above the block, inside its item.
    const halo = dentist.querySelector(".day-timeline-halo") as HTMLElement;
    expect(halo.style.top).toBe("-15px");
    expect(halo.style.height).toBe("15px");
  });

  it("keeps a Nothing fits label off a block, and keeps the line and its title", () => {
    const covered = {
      ...plan,
      lines: [
        { id: "gap:y", kind: "gap" as const, at: at("2026-08-19T04:20:00.000Z"), label: "Nothing fits · Take a break" }
      ]
    };
    const { container } = render(
      <DayTimeline plan={covered} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const line = container.querySelector(".day-timeline-line-gap")!;
    expect(line.textContent).toBe("");
    expect(line.getAttribute("title")).toContain("Nothing fits · Take a break");
  });

  it("marks the engine's directive as planned, draws the next-fit marker, and hides reservations until asked", () => {
    const { container, rerender } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const directive = screen.getByRole("button", { name: "Write the intro, 10:00 am to 11:00 am" });
    expect(directive.className).toContain("day-timeline-block-engine");
    expect(within(directive).getByText("planned")).toBeTruthy();
    // A simulated block says it is a projection, and a missed deadline is marked on the block itself.
    const projected = screen.getByRole("button", { name: "Reconcile receipts, 4:30 pm to 5:00 pm" });
    expect(projected.className).toContain("day-timeline-block-engine");
    expect(projected.className).toContain("projected");
    expect(projected.className).toContain("displaced");
    expect(within(projected).getByText("projected")).toBeTruthy();
    expect(within(directive).queryByText("projected")).toBeNull();
    expect(container.querySelector(".day-timeline-line-gap")!.textContent).toContain(
      "Nothing fits · waiting on an answer"
    );
    const marker = screen.getByRole("button", { name: "Next fit: Receipts, 7:00 pm" });
    expect(marker.className).toContain("day-timeline-marker");
    expect(screen.queryByRole("button", { name: /Reserved: Reconcile/ })).toBeNull();
    rerender(<DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved onSelect={() => {}} />);
    const reserved = screen.getByRole("button", { name: "Reserved: Reconcile, 4:00 pm to 4:30 pm" });
    expect(reserved.textContent).toContain("reserved by Fri, 21 Aug");
    expect(container.querySelector(".day-timeline-reserved-block")).toBe(reserved);
  });

  it("draws the now-line from the plan's now, announces it, and dims what has passed", () => {
    const { container } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const now = screen.getByTestId("day-timeline-now");
    expect(now.style.top).toBe("600px");
    expect(now.textContent).toBe("10:00 am");
    expect(screen.getByText("Now 10:00 am").getAttribute("aria-live")).toBe("polite");
    const elapsed = container.querySelector(".day-timeline-band-elapsed") as HTMLElement;
    expect(elapsed.style.height).toBe("600px");
    expect(container.querySelector(".day-timeline-line-horizon")!.textContent).toContain("Daily horizon · 10:00 pm");
  });

  it("puts untimed chips in the first free gap after now, never as a timed block, and omits the now-line on another day", () => {
    const { container, rerender } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const strip = screen.getByRole("group", { name: "Next up, not yet timed" });
    // The directive block is engine-placed and does not occupy the gap; the first fixed thing is at 2 pm.
    expect((strip as HTMLElement).style.top).toBe("600px");
    expect(within(strip).getByText("Read chapter 3 · 30 min").tagName).toBe("SPAN");
    expect(container.querySelector(".day-timeline-untimed-foot")).toBeNull();
    rerender(
      <DayTimeline
        plan={{ ...plan, nowAt: null }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    expect(screen.queryByTestId("day-timeline-now")).toBeNull();
    expect(container.querySelector(".day-timeline-untimed-foot")).not.toBeNull();
  });

  it("reports the tapped item and chip to the caller", () => {
    const onSelect = vi.fn();
    const onChip = vi.fn();
    render(
      <DayTimeline
        plan={plan}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved
        onSelect={onSelect}
        onSelectUntimed={onChip}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }));
    fireEvent.click(screen.getByRole("button", { name: /Reserved: Reconcile/ }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "r" }));
    fireEvent.click(screen.getByRole("button", { name: "Read chapter 3 · 30 min" }));
    expect(onChip).toHaveBeenCalledWith(expect.objectContaining({ id: "u" }));
  });

  it("draws the projected location band beside the gutter, hatching the leg and naming each stay in its title", () => {
    const { container } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    const strip = screen.getByRole("list", { name: "Where the projected day puts you" });
    const segments = [...strip.querySelectorAll<HTMLElement>(".day-timeline-location")];
    expect(segments).toHaveLength(3);
    // Home runs midnight to 1:30 pm: 13.5 h × 60 px, from the top of the day.
    expect(segments[0]!.style.top).toBe("0px");
    expect(segments[0]!.style.height).toBe("810px");
    expect(segments[0]!.title).toBe("Home · 12:00 am–1:30 pm");
    // In transit is nowhere in particular: hatched by its class, never given a colour of its own.
    expect(segments[1]!.className).toContain("transit");
    expect(segments[1]!.style.background).toBe("");
    expect(segments[1]!.style.height).toBe("30px");
    expect(segments[1]!.title).toBe("In transit · 1:30 pm–2:00 pm");
    // Nothing is written down the strip, where it would run into the hour labels.
    expect(segments.map((segment) => segment.textContent)).toEqual(["", "", ""]);
    expect(segments[2]!.title).toMatch(/^Campus · /);
    // A place gets a colour of its own, decided by its id rather than by its position in the day.
    expect(segments[0]!.style.background).not.toBe("");
    expect(segments[0]!.style.background).not.toBe(segments[2]!.style.background);
    expect(locationColour("ctx-home")).toBe(locationColour("ctx-home"));
    expect(locationColour("ctx-home")).not.toBe(locationColour("ctx-campus"));
    const { container: bare } = render(
      <DayTimeline
        plan={{ ...plan, locations: [] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    expect(container.querySelector(".day-timeline-locations")).not.toBeNull();
    expect(bare.querySelector(".day-timeline-locations")).toBeNull();
  });

  it("draws the waits strip beside the location strip, running solid and projected lighter", () => {
    const waitsPlan: DayPlan = {
      ...plan,
      waits: [
        {
          id: "wait:wash",
          stepId: "wash",
          title: "Wash · ready 9:35 pm",
          anchorTitle: "Work",
          running: true,
          startsAt: at("2026-08-19T09:05:00.000Z"),
          endsAt: at("2026-08-19T10:35:00.000Z")
        },
        {
          id: "wait:hangout",
          stepId: "hangout",
          title: "Hang out washing · ready 11:00 pm",
          anchorTitle: "Work",
          running: false,
          startsAt: at("2026-08-19T10:35:00.000Z"),
          endsAt: at("2026-08-19T13:00:00.000Z")
        }
      ]
    };
    render(<DayTimeline plan={waitsPlan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />);
    const strip = screen.getByRole("list", { name: "Waits" });
    const segments = [...strip.querySelectorAll<HTMLElement>(".day-timeline-wait")];
    expect(segments).toHaveLength(2);
    expect(segments[0]!.className).toContain("running");
    expect(segments[1]!.className).toContain("projected");
    const { container: bare } = render(
      <DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    expect(bare.querySelector(".day-timeline-waits")).toBeNull();
  });

  it("draws a leave-by marker and a start-by marker, styled by urgency", () => {
    const markerPlan: DayPlan = {
      ...plan,
      items: [
        ...plan.items,
        item({
          id: "leave_by:dentist",
          kind: "leave_by",
          title: "Leave by 8:10 am for Dentist",
          subtitle: "usually 22 min · allowing 28",
          marker: true,
          startsAt: at("2026-08-18T22:10:00.000Z"),
          endsAt: at("2026-08-18T22:10:00.000Z")
        }),
        item({
          id: "start_by:wash",
          kind: "start_by",
          title: "Start Wash by 7:30 pm",
          marker: true,
          urgency: "missed",
          startsAt: at("2026-08-19T09:30:00.000Z"),
          endsAt: at("2026-08-19T09:30:00.000Z")
        })
      ]
    };
    render(<DayTimeline plan={markerPlan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />);
    const leaveBy = screen.getByTitle(/Leave by 8:10 am for Dentist/);
    expect(leaveBy.className).toContain("day-timeline-marker-leave_by");
    const startBy = screen.getByTitle(/Start Wash by 7:30 pm/);
    expect(startBy.className).toContain("day-timeline-marker-start_by");
    expect(startBy.className).toContain("missed");
  });

  it("draws a soft cadence placement as a dashed reservation, only while showReserved is on", () => {
    const softPlan: DayPlan = {
      ...plan,
      reserved: [
        ...plan.reserved,
        item({
          id: "soft:gym:2026-08-19T04:00:00.000Z",
          kind: "soft",
          source: "reserved",
          title: "Gym",
          subtitle: "2 of 3 fit this week",
          startsAt: at("2026-08-19T04:00:00.000Z"),
          endsAt: at("2026-08-19T05:00:00.000Z")
        })
      ]
    };
    const { container: shown } = render(
      <DayTimeline plan={softPlan} timezone={TZ} pixelsPerHour={60} showReserved onSelect={() => {}} />
    );
    const soft = shown.querySelector(".day-timeline-reserved-block.soft")!;
    expect(soft).not.toBeNull();
    expect(soft.textContent).toContain("2 of 3 fit this week");
    const { container: hidden } = render(
      <DayTimeline plan={softPlan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />
    );
    expect(hidden.querySelector(".day-timeline-reserved-block.soft")).toBeNull();
  });

  it("draws a leg as its own block, kept apart from the work at either end", () => {
    render(
      <DayTimeline
        plan={{ ...plan, items: [...plan.items, travel] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    const leg = screen.getByRole("button", { name: "Drive to Campus, 1:30 pm to 1:48 pm" });
    expect(leg.className).toContain("day-timeline-block-kind-travel");
    // Eighteen minutes has room for the leg's name and nothing under it; the agenda and the detail
    // sheet are where "18 min · then Assessment 2" is read.
    expect(leg.textContent).toBe("plannedDrive to Campus");
    expect(leg.getAttribute("title")).toBe("Drive to Campus, 1:30 pm to 1:48 pm");
  });

  it("pushes a run of short blocks apart in pixels, keeps their stated times, and grows the canvas", () => {
    // Five short steps five minutes apart at the end of the day: 4 px of real height each, drawn 26.
    const steps = [35, 40, 45, 50, 55].map((minute, index) =>
      item({
        id: `step-${index}`,
        kind: "routine_step",
        title: `Step ${index}`,
        startsAt: at(`2026-08-19T13:${minute}:00.000Z`),
        endsAt: at(`2026-08-19T13:${minute + 4}:00.000Z`),
        ...(index === 2
          ? { halos: [{ startsAt: at("2026-08-19T13:30:00.000Z"), endsAt: at("2026-08-19T13:45:00.000Z") }] }
          : {})
      })
    );
    const { container } = render(
      <DayTimeline
        plan={{ ...plan, items: steps, reserved: [], untimed: [], locations: [] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    const rows = [...container.querySelectorAll<HTMLElement>(".day-timeline-item")];
    // True tops are 1415, 1420, 1425, 1430, 1435; each block clears the 26 px one above it.
    expect(rows.map((row) => row.style.top)).toEqual(["1415px", "1441px", "1467px", "1493px", "1519px"]);
    expect(rows.every((row) => row.style.height === "26px")).toBe(true);
    expect(rows.every((row) => row.style.width === "100%")).toBe(true);
    // The clock is untouched: the block still says when it happens, and the hour rules have not moved.
    expect(screen.getByRole("button", { name: "Step 4, 11:55 pm to 11:59 pm" })).toBeTruthy();
    const hours = container.querySelectorAll<HTMLElement>(".day-timeline-hour");
    expect(hours[23]!.style.top).toBe("1380px");
    // The last block ends at 1545 px, past the 1440 px day; the canvas grows so it stays reachable.
    expect((container.querySelector(".day-timeline-canvas") as HTMLElement).style.height).toBe("1545px");
    // The halo keeps its true position, which on a pushed block means reaching further above it.
    const halo = rows[2]!.querySelector(".day-timeline-halo") as HTMLElement;
    expect(halo.style.top).toBe("-57px");
    expect(halo.style.height).toBe("15px");
  });

  it("gives every block a full line of title and drops the second line rather than slicing it", () => {
    const short = item({
      id: "short",
      kind: "routine_step",
      title: "Get drink bottle",
      subtitle: "Before Work · 10 min",
      startsAt: at("2026-08-19T02:00:00.000Z"),
      endsAt: at("2026-08-19T02:10:00.000Z")
    });
    const tall = item({
      id: "tall",
      kind: "commitment",
      title: "Shift",
      subtitle: "Harbor Mart – Riverside",
      startsAt: at("2026-08-19T08:00:00.000Z"),
      endsAt: at("2026-08-19T09:00:00.000Z")
    });
    const { container } = render(
      <DayTimeline
        plan={{ ...plan, items: [short, tall], reserved: [], untimed: [], locations: [] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    // Ten minutes is 10 px of clock; the block is drawn 26 so its one line of title is whole.
    const rows = [...container.querySelectorAll<HTMLElement>(".day-timeline-item")];
    expect(rows[0]!.style.height).toBe("26px");
    const cramped = screen.getByRole("button", { name: "Get drink bottle, 12:00 pm to 12:10 pm" });
    expect(cramped.textContent).toBe("Get drink bottle");
    expect(cramped.querySelector(".day-timeline-block-meta")).toBeNull();
    // An hour has room for both lines, so the subtitle is drawn.
    const roomy = screen.getByRole("button", { name: "Shift, 6:00 pm to 7:00 pm" });
    expect(roomy.querySelector(".day-timeline-block-meta")!.textContent).toBe("Harbor Mart – Riverside");
  });

  it("folds a wall of minimum-height steps into one block that names the run and counts its members", () => {
    // Six five-minute steps back to back: 5 px of real height each against a 26 px minimum, so drawn
    // one by one they are a wall of slivers with no room for a word in any of them.
    const steps = [0, 5, 10, 15, 20, 25].map((minute, index) =>
      item({
        id: `step-${index}`,
        kind: "routine_step",
        title: `Step ${index}`,
        parentId: "college",
        groupTitle: "Before College",
        startsAt: at(`2026-08-19T00:${String(minute).padStart(2, "0")}:00.000Z`),
        endsAt: at(`2026-08-19T00:${String(minute + 5).padStart(2, "0")}:00.000Z`)
      })
    );
    const onSelect = vi.fn();
    const { container } = render(
      <DayTimeline
        plan={{ ...plan, items: steps, reserved: [], untimed: [], locations: [] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={onSelect}
      />
    );
    const rows = [...container.querySelectorAll<HTMLElement>(".day-timeline-item")];
    expect(rows).toHaveLength(1);
    // The fold spans the run's true time, so it needs no push-down at all: 30 minutes, 30 px.
    expect(rows[0]!.style.top).toBe("600px");
    expect(rows[0]!.style.height).toBe("30px");
    const folded = screen.getByRole("button", { name: "Before College · 6 steps, 10:00 am to 10:30 am" });
    expect(folded.className).toContain("grouped");
    // Thirty pixels holds the name and the count and nothing else; the members are in the sheet.
    expect(folded.textContent).toBe("Before College · 6 steps");
    // A tap lands on the step the run starts at, which is where its editor is, and carries the members.
    fireEvent.click(folded);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "step-0",
        grouped: true,
        steps: expect.arrayContaining([expect.objectContaining({ title: "Step 5" })])
      })
    );
  });

  it("folds steps the planner spread out, when the gaps between them are too small to draw", () => {
    // Four ten-minute steps five minutes apart: a real gap, but one no scale here can show, so drawn
    // apart they are four slivers in a column with truncated names.
    const steps = [0, 15, 30, 45].map((minute, index) =>
      item({
        id: `step-${index}`,
        kind: "routine_step",
        title: `Step ${index}`,
        parentId: "work",
        groupTitle: "Before Work",
        startsAt: at(`2026-08-19T00:${String(minute).padStart(2, "0")}:00.000Z`),
        endsAt: at(`2026-08-19T00:${String(minute + 10).padStart(2, "0")}:00.000Z`)
      })
    );
    const { container } = render(
      <DayTimeline
        plan={{ ...plan, items: steps, reserved: [], untimed: [], locations: [] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    expect(container.querySelectorAll(".day-timeline-item")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Before Work · 4 steps, 10:00 am to 10:55 am" })).toBeTruthy();
  });

  it("draws an eligibility window as a band with one label, taking no column from the day's events", () => {
    const morning = item({
      id: "occurrence:floss",
      kind: "occurrence",
      title: "Brush and floss twice daily",
      subtitle: "Morning window · pending",
      window: true,
      parentId: "action:floss",
      startsAt: at("2026-08-18T19:30:00.000Z"),
      endsAt: at("2026-08-18T22:30:00.000Z")
    });
    const evening = item({
      ...morning,
      id: "occurrence:floss-pm",
      subtitle: "Bedtime window · pending",
      startsAt: at("2026-08-18T19:40:00.000Z"),
      endsAt: at("2026-08-18T23:00:00.000Z")
    });
    const onSelect = vi.fn();
    const { container } = render(
      <DayTimeline
        plan={{ ...plan, items: [...plan.items, morning, evening] }}
        timezone={TZ}
        pixelsPerHour={60}
        showReserved={false}
        onSelect={onSelect}
      />
    );
    const bands = [...container.querySelectorAll<HTMLElement>(".day-timeline-window")];
    expect(bands).toHaveLength(2);
    // 5:30 am to 8:30 am local: three hours from the sixth hour of the day.
    expect(bands[0]!.style.top).toBe("330px");
    expect(bands[0]!.style.height).toBe("180px");
    // Not in the blocks list, so it neither takes a column nor is one taken from it.
    expect(container.querySelector(".day-timeline-items")!.querySelector(".day-timeline-window")).toBeNull();
    const dentist = screen.getByRole("button", { name: "Dentist, 2:00 pm to 3:00 pm" }).closest("li")!;
    expect(dentist.style.width).toBe("50%");
    // Two overlapping windows tint the same stretch; only their labels step apart, and only as far as
    // clears the first: 332px to 352px, so the second band (340px) puts its chip at 353px.
    const labels = [...container.querySelectorAll<HTMLElement>(".day-timeline-window-label")];
    expect(labels.map((chip) => chip.style.top)).toEqual(["2px", "13px"]);
    expect(labels[0]!.textContent).toBe("Brush and floss twice daily · Morning window · pending");
    // The layer is inert — the stylesheet makes it so — and the label is the whole of the target.
    const layer = screen.getByRole("list", { name: "Windows something may happen in" });
    expect(layer.className).toBe("day-timeline-windows");
    fireEvent.click(labels[0]!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "occurrence:floss" }));
  });

  it("repeats the block's own from–till as a hover title, on plain blocks, markers and reservations alike", () => {
    render(<DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved onSelect={() => {}} />);
    for (const name of [
      "Dentist, 2:00 pm to 3:00 pm",
      "Next fit: Receipts, 7:00 pm",
      "Reserved: Reconcile, 4:00 pm to 4:30 pm"
    ])
      expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(name);
  });

  it("says when a block continues past midnight", () => {
    render(<DayTimeline plan={plan} timezone={TZ} pixelsPerHour={60} showReserved={false} onSelect={() => {}} />);
    const sleep = screen.getByRole("button", { name: "Sleep, 10:00 pm to 12:00 am, continues after midnight" });
    expect(sleep.className).toContain("clipped-end");
  });
});

describe("DayAgendaList", () => {
  it("lists the same items in start order with their source, then the untimed chips", () => {
    const onSelect = vi.fn();
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={onSelect} />);
    const list = screen.getByRole("list", { name: "Day agenda" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")!.textContent)).toEqual([
      "Dentist",
      "Draft report",
      "Write the intro",
      "Reconcile receipts",
      "Next fit: Receipts",
      "Sleep"
    ]);
    expect(rows[0]!.textContent).toContain("2:00 pm–3:00 pm");
    expect(rows[2]!.querySelector(".day-agenda-source")!.textContent).toBe("planned");
    expect(rows[3]!.querySelector(".day-agenda-source")!.textContent).toBe("projected");
    expect(rows[5]!.textContent).toContain("10:00 pm–…");
    expect(screen.getByRole("group", { name: "Next up, not yet timed" }).textContent).toContain(
      "Read chapter 3 · 30 min"
    );
    fireEvent.click(within(rows[1]!).getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "s" }));
  });

  it("marks a leg as travel so its minutes never read as work", () => {
    render(
      <DayAgendaList plan={{ ...plan, items: [travel] }} timezone={TZ} showReserved={false} onSelect={() => {}} />
    );
    const rows = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Travel · 18 min · then Assessment 2");
  });

  it("keeps a window's row quiet and its long title to one line, with the whole of it on hover", () => {
    const window = item({
      id: "occurrence:floss",
      kind: "occurrence",
      title: "Stretch for ten minutes twice daily, log it each evening, and keep going",
      subtitle: "Morning window · covered by Brush teeth · Wind down",
      window: true,
      coveredBy: "Brush teeth · Wind down"
    });
    render(
      <DayAgendaList
        plan={{ ...plan, items: [window], reserved: [], untimed: [] }}
        timezone={TZ}
        showReserved={false}
        onSelect={() => {}}
      />
    );
    const row = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem")[0]!;
    expect(row.className).toContain("day-agenda-row-window");
    expect(row.querySelector("strong")!.getAttribute("title")).toBe(window.title);
    expect(row.textContent).toContain("Morning window · covered by Brush teeth · Wind down");
  });

  it("leaves an ordinary row's title free to wrap", () => {
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
    const row = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem")[0]!;
    expect(row.className).not.toContain("day-agenda-row-window");
    expect(row.querySelector("strong")!.getAttribute("title")).toBeNull();
  });

  it("interleaves reservations only when asked and labels them as not sessions", () => {
    render(<DayAgendaList plan={plan} timezone={TZ} showReserved onSelect={() => {}} />);
    const rows = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(rows[3]!.textContent).toContain("Reserved by Fri, 21 Aug · not a session");
  });

  it("shows each wait as its own row, styled like a window row", () => {
    const waitsPlan: DayPlan = {
      ...plan,
      waits: [
        {
          id: "wait:wash",
          stepId: "wash",
          title: "Wash · ready 9:35 pm",
          anchorTitle: "Work",
          running: true,
          startsAt: at("2026-08-19T09:05:00.000Z"),
          endsAt: at("2026-08-19T10:35:00.000Z")
        }
      ]
    };
    render(<DayAgendaList plan={waitsPlan} timezone={TZ} showReserved={false} onSelect={() => {}} />);
    const rows = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem");
    const waitRow = rows.find((row) => row.className.includes("day-agenda-row-wait"))!;
    expect(waitRow).toBeDefined();
    expect(waitRow.className).toContain("day-agenda-row-window");
    expect(waitRow.textContent).toContain("Waiting · Wash until 8:35 pm");
  });

  it("shows a soft cadence placement's subtitle as room, not a session", () => {
    const softPlan: DayPlan = {
      ...plan,
      reserved: [
        item({
          id: "soft:gym",
          kind: "soft",
          source: "reserved",
          title: "Gym",
          subtitle: "2 of 3 fit this week",
          startsAt: at("2026-08-19T04:00:00.000Z"),
          endsAt: at("2026-08-19T05:00:00.000Z")
        })
      ]
    };
    render(<DayAgendaList plan={softPlan} timezone={TZ} showReserved onSelect={() => {}} />);
    const rows = within(screen.getByRole("list", { name: "Day agenda" })).getAllByRole("listitem");
    const softRow = rows.find((row) => row.textContent?.includes("Gym"))!;
    expect(softRow.textContent).toContain("2 of 3 fit this week · not held for anyone");
  });
});
