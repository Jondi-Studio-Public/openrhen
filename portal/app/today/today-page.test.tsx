// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { primarySourceConnection } from "@openrhen/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";

// 10:00 am Wednesday in the seed zone; the seed's "Dinner and reset" commitment lands at 12:00–1:00 pm.
const now = new Date("2026-08-19T00:00:00.000Z");
// Preparation for that commitment, placed at 11:00 am, so the day has a routine_step block on it.
const prepStep = {
  id: "bins",
  version: 4,
  commitmentId: "dinner",
  title: "Take the bins out",
  durationMinutes: 15,
  sequence: 0,
  timingRule: "flexible" as const,
  maxLeadMinutes: 120,
  energy: "low" as const,
  contexts: ["home"],
  dependencyIds: [],
  phase: "before" as const,
  status: "pending" as const,
  scheduledStartAt: "2026-08-19T01:00:00.000Z",
  scheduledEndAt: "2026-08-19T01:15:00.000Z"
};
const seed = createSeedState(now);
const state = {
  ...seed,
  routineSteps: [...seed.routineSteps, prepStep],
  planning: { status: "current" as const }
};
const context = {
  state,
  ready: true,
  saving: false,
  slots: [],
  allocations: [],
  recommendation: null,
  currentDirective: {
    kind: "action",
    targetId: state.actions[0]!.id,
    title: "Write the intro",
    recommendedMinutes: 30
  },
  upcomingDirectives: [{ kind: "action", targetId: "a2", title: "Read chapter 3", recommendedMinutes: 20 }],
  saveEntityCommand: vi.fn(),
  saveCommitmentRecurrenceRuleCommand: vi.fn()
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));
const navigateTo = vi.fn();
vi.mock("@/shared/navigate", () => ({ navigateTo: (href: string) => navigateTo(href) }));
const lapses = {
  lapsed: [] as unknown[],
  rosterSyncedAt: null as string | null,
  rosterHistoryDays: null as number | null,
  ready: true
};
vi.mock("@/features/connections/connection-lapses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/connections/connection-lapses")>()),
  useConnectionLapses: () => lapses
}));
// The page reads the clock from the store rather than the context, so it is frozen at the same instant.
freezeClock(now);

let matches = false;
beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  window.location.hash = "";
  // Composition is by view mode as well as by width; these cases are advanced unless they say so.
  window.localStorage.clear();
  navigateTo.mockClear();
});

const dialogs = () => screen.queryAllByRole("dialog");
const sessionFixture = {
  id: "session-one",
  actionId: "a1",
  actionTitle: "Draft the essay",
  result: "completed",
  startedAt: "2026-08-18T22:00:00.000Z",
  endedAt: "2026-08-18T22:45:00.000Z",
  plannedMinutes: 45,
  activeMinutes: 40,
  remainingBeforeMinutes: 90,
  remainingAfterMinutes: 50
};
const sleepFixture = {
  id: "night-one",
  status: "planned",
  plannedStartAt: "2026-08-18T12:00:00.000Z",
  plannedWakeAt: "2026-08-18T20:00:00.000Z",
  allowedMinutes: 480,
  targetMinutes: 480,
  explanation: "Full night available",
  hardErrors: []
};
const occurrenceFixture = {
  id: "morning-meds",
  actionId: "a1",
  localDate: "2026-08-19",
  windowId: "window-morning",
  windowName: "Morning",
  windowStartsAt: "2026-08-18T21:00:00.000Z",
  windowEndsAt: "2026-08-18T22:00:00.000Z",
  anchorSource: "planned_wake",
  status: "pending"
};
/** Runs one case against a state with extra facts on it, restoring the shared one afterwards. */
async function withState(extra: Record<string, unknown>, run: () => Promise<void> | void) {
  const original = context.state;
  context.state = { ...state, ...extra };
  try {
    await run();
  } finally {
    context.state = original;
  }
}
const loadPage = async () => (await import("./page")).default;

describe("Today page composition", () => {
  // Warm the page module once: its cold import under a loaded full-suite run can outlast the first
  // test's 5-second budget, and a timed-out render then leaks into the next test.
  beforeAll(async () => {
    await import("./page");
  }, 60_000);

  it("on a phone leads with Today and a seven-day strip, then the day plan as a list with today's work on it", async () => {
    matches = false;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Today");
    const strip = screen.getByRole("group", { name: "Which day" });
    const days = within(strip).getAllByRole("button");
    expect(days).toHaveLength(7);
    expect(days[0]!.getAttribute("aria-label")).toBe("Wednesday 19 August");
    expect(days[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(days[1]!.getAttribute("aria-pressed")).toBe("false");
    // Paging belongs to the strip on a phone; the desk's arrows are not drawn.
    expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Day plan" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Day plan" });
    expect(within(card).getByRole("list", { name: "Day agenda" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^12:00 pm.*Dinner and reset/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Write the intro/ })).toBeTruthy();
    expect(within(card).getByRole("group", { name: "Next up, not yet timed" }).textContent).toContain("Read chapter 3");
    // The quick-add launcher is a side row now, not a button on the card.
    expect(within(card).queryByRole("button", { name: "Add commitment" })).toBeNull();
  });

  it("says how old the roster is once its last good sync is over two days old, and says nothing before", async () => {
    const TodayPage = await loadPage();
    lapses.rosterSyncedAt = "2026-08-17T00:00:00.000Z";
    const { unmount } = render(<TodayPage />);
    expect(screen.queryByText(/Roster last synced/)).toBeNull();
    unmount();
    lapses.rosterSyncedAt = "2026-08-10T00:00:00.000Z";
    render(<TodayPage />);
    expect(screen.getByRole("link", { name: "Roster last synced 9 days ago" }).getAttribute("href")).toBe(
      `/connections#${primarySourceConnection()!.id}`
    );
    lapses.rosterSyncedAt = null;
  });

  it("keeps a roster warning when pruning has left no good sync to date", async () => {
    const TodayPage = await loadPage();
    lapses.rosterHistoryDays = 88;
    render(<TodayPage />);
    expect(screen.getByRole("link", { name: "Roster hasn't synced in over 88 days" })).toBeTruthy();
    lapses.rosterHistoryDays = null;
  });

  it("on a desk is headed by the date, answers in a sentence, and draws the timeline with now on it", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Wednesday 19 August");
    expect(screen.queryByRole("group", { name: "Which day" })).toBeNull();
    expect(screen.getByText(/One fixed thing: Dinner and reset at 12:00 pm\./)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Timeline" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Dinner and reset, 12:00 pm to 1:00 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write the intro, 10:00 am to 10:30 am" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Next up, not yet timed" }).textContent).toContain("Read chapter 3");
    expect(screen.getByTestId("day-timeline-now")).toBeTruthy();
  });

  it("on a desk opens the engine sheet from a planned block", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: "Write the intro, 10:00 am to 10:30 am" }));
    const sheet = screen.getByRole("dialog", { name: "Planned for you" });
    expect(within(sheet).getByRole("heading", { level: 3, name: "Write the intro" })).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: "Open Now" }).getAttribute("href")).toBe("/");
  });

  it("pages seven days on a desk, gives later days no now-shaped inputs, and comes back on Today", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    const previous = screen.getByRole("button", { name: "Previous day" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement;
    const today = screen.getByRole("button", { name: "Today" });
    expect(previous.disabled).toBe(true);
    expect(today.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(next);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Thursday 20 August");
    expect(previous.disabled).toBe(false);
    expect(today.getAttribute("aria-pressed")).toBe("false");
    // The directive and the ranking's next item are answers about this minute, not about tomorrow.
    expect(screen.queryByRole("button", { name: /^Write the intro,/ })).toBeNull();
    expect(screen.queryByText("Read chapter 3")).toBeNull();
    expect(screen.queryByTestId("day-timeline-now")).toBeNull();

    for (let step = 0; step < 8; step += 1) fireEvent.click(next);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tuesday 25 August");
    expect(next.disabled).toBe(true);

    fireEvent.click(previous);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Monday 24 August");
    fireEvent.click(today);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Wednesday 19 August");
    expect(screen.getByRole("button", { name: "Write the intro, 10:00 am to 10:30 am" })).toBeTruthy();
  });

  it("pages from the week strip on a phone, naming the weekday and marking the pressed day", async () => {
    matches = false;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: "Friday 21 August" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Friday");
    expect(screen.getByRole("button", { name: "Friday 21 August" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Wednesday 19 August" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Write the intro,/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wednesday 19 August" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Today");
  });

  it("writes tomorrow's brief onto the card only while tomorrow is the day shown", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.queryByText(/^First: /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    const card = screen.getByRole("region", { name: "Day plan" });
    expect(card.querySelector("[data-day]")!.getAttribute("data-day")).toBe("2026-08-20");
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(card.querySelector("[data-day]")!.getAttribute("data-day")).toBe("2026-08-21");
    expect(screen.queryByText(/^First: /)).toBeNull();
  });

  it("keeps latest safe starts off until the page's own switch is on", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    const toggle = screen.getByRole("switch", { name: "Show latest safe starts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/not sessions and not when to do the work/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/not sessions and not when to do the work/)).toBeTruthy();
    // The card has no reservations checkbox of its own any more.
    expect(screen.queryByRole("checkbox", { name: /reservations/ })).toBeNull();
  });

  /*
   * The management panels are gone from Today in every width: the week grid and rule catalog on
   * /schedule replaced two of them, and the routine section on a commitment's own page the third.
   * What Today keeps is the day itself, and one sheet per side row.
   */
  it("no longer lists commitments, recurrence rules or preparation steps", async () => {
    matches = true;
    const TodayPage = await loadPage();
    const { container } = render(<TodayPage />);
    expect(screen.queryByRole("heading", { name: "Today’s fixed commitments" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recurring commitments" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Preparation" })).toBeNull();
    expect(screen.queryByText(/Later commitments/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add preparation step" })).toBeNull();
    expect(container.querySelector("#today-preparation")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("lists the side rows, with the recurring-commitments row a link to the schedule's catalog", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    const rows = screen.getByRole("region", { name: "Shape the day" });
    for (const name of [/^Direction for today/, /^Change the day/, /^Sleep plan/, /^Recorded today/])
      expect(within(rows).getByRole("button", { name })).toBeTruthy();
    expect(
      within(rows)
        .getByRole("link", { name: /^Recurring commitments/ })
        .getAttribute("href")
    ).toBe("/schedule#recurring");
    // Nothing recurs on this day, so there is no row for windows.
    expect(within(rows).queryByRole("button", { name: /^Recurring windows/ })).toBeNull();
    expect(dialogs()).toHaveLength(0);
  });

  it("opens the direction sheet from its row, with the way to save today's direction in it", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Direction for today/ }));
    const sheet = screen.getByRole("dialog", { name: "Direction for today" });
    expect(within(sheet).getByRole("button", { name: "Save today’s direction" })).toBeTruthy();
  });

  // Add only: an existing commitment is edited on its own page and a rule on /schedule, but writing
  // down something that has just landed in the diary still belongs to the day.
  it.each([
    ["a phone", false],
    ["a desk", true]
  ])("hosts the plan change and the blank add-commitment form in one sheet on %s", async (_label, desk) => {
    matches = desk;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Change the day/ }));
    const sheet = screen.getByRole("dialog", { name: "Change the day" });
    expect((within(sheet).getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect(dialogs()).toHaveLength(1);
  });

  it("opens the sleep sheet from its row, with a way to correct a past night inside it", async () => {
    matches = false;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Sleep plan/ }));
    const sheet = screen.getByRole("dialog", { name: "Sleep plan" });
    expect(within(sheet).getByRole("link", { name: "Correct a past night" }).getAttribute("href")).toBe("/sleep");
  });

  it("opens Recorded today from its row, saying so while nothing has ended", async () => {
    matches = false;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Recorded today/ }));
    const sheet = screen.getByRole("dialog", { name: "Recorded today" });
    expect(within(sheet).getByText("Sessions you finish, stop or get blocked on today will show here.")).toBeTruthy();
  });

  it("offers a Recurring windows row only when windows fall on the day shown", async () => {
    matches = true;
    await withState({ occurrences: [occurrenceFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      fireEvent.click(screen.getByRole("button", { name: /^Recurring windows/ }));
      const sheet = screen.getByRole("dialog", { name: "Recurring windows" });
      expect(within(sheet).getByText(/Morning/)).toBeTruthy();
      fireEvent.click(within(sheet).getByRole("button", { name: /^Close / }));
    });
  });

  it("drops the Recurring windows row on a day the windows do not fall on", async () => {
    matches = true;
    await withState({ occurrences: [occurrenceFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      expect(screen.getByRole("button", { name: /^Recurring windows/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Next day" }));
      expect(screen.queryByRole("button", { name: /^Recurring windows/ })).toBeNull();
    });
  });

  // Settings and the user guide link to these; the anchors name a sheet now rather than a panel.
  it.each([
    ["#direction", "Direction for today"],
    ["#sleep", "Sleep plan"],
    ["#today-sleep", "Sleep plan"],
    ["#sessions", "Recorded today"],
    ["#today-sessions", "Recorded today"]
  ])("opens the matching sheet on arrival from %s", async (hash, title) => {
    matches = true;
    window.location.hash = hash;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
  });

  it.each([["#occurrences"], ["#today-occurrences"]])("opens Recurring windows on arrival from %s", async (hash) => {
    matches = true;
    window.location.hash = hash;
    await withState({ occurrences: [occurrenceFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      expect(screen.getByRole("dialog", { name: "Recurring windows" })).toBeTruthy();
    });
  });

  it.each([
    ["sleep", "Sleep plan"],
    ["sessions", "Recorded today"],
    ["occurrences", "Recurring windows"]
  ])("opens the matching sheet on arrival from ?open=%s", async (name, title) => {
    matches = true;
    window.history.replaceState(null, "", `/?open=${name}`);
    try {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("opens on the day a link from the week names, and paging by hand leaves it", async () => {
    matches = false;
    window.history.replaceState(null, "", "/today?day=2026-08-21");
    try {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      const strip = within(screen.getByRole("group", { name: "Which day" }));
      expect(strip.getByRole("button", { name: /Friday/ }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(strip.getByRole("button", { name: /Saturday/ }));
      expect(strip.getByRole("button", { name: /Saturday/ }).getAttribute("aria-pressed")).toBe("true");
      expect(strip.getByRole("button", { name: /Friday/ }).getAttribute("aria-pressed")).toBe("false");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("leaves every sheet shut when nothing links to one, on a phone as on a desk", async () => {
    const TodayPage = await loadPage();
    for (const desk of [false, true]) {
      matches = desk;
      const { unmount } = render(<TodayPage />);
      expect(dialogs()).toHaveLength(0);
      unmount();
    }
  });

  it("opens a sheet when the hash changes while the page is open, and drops the hash on close", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(dialogs()).toHaveLength(0);
    act(() => {
      window.location.hash = "#direction";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const sheet = screen.getByRole("dialog", { name: "Direction for today" });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Close / }));
    expect(window.location.hash).toBe("");
  });

  it("shows only one sheet at a time, whichever row was pressed last", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    window.location.hash = "#sleep";
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("dialog", { name: "Sleep plan" })).toBeTruthy();
    act(() => {
      window.location.hash = "#sessions";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByRole("dialog", { name: "Sleep plan" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Recorded today" })).toBeTruthy();
  });

  it("no longer hosts manual capacity windows or their editor; that lives in Settings now", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.queryByRole("heading", { name: "Capacity windows" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Add capacity window" })).toBe(null);
    expect(screen.queryByText(/Automatic free-time mode is active/)).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /^Change the day/ }));
    const sheet = screen.getByRole("dialog", { name: "Change the day" });
    expect(within(sheet).queryByRole("button", { name: "Add capacity window" })).toBe(null);
    expect(within(sheet).getByLabelText("Title")).toBeTruthy();
  });

  it("leaves the automatic free-time capacity figures to Settings", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    expect(screen.queryByRole("heading", { name: "Automatic free-time capacity" })).toBe(null);
  });

  // The block is the primary click-through to the commitment's own page, which carries its routine,
  // its series and where it came from.
  it("opens the commitment's own page from a commitment block", async () => {
    matches = true;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: "Dinner and reset, 12:00 pm to 1:00 pm" }));
    expect(navigateTo).toHaveBeenCalledWith("/commitments/dinner");
    expect(dialogs()).toHaveLength(0);
  });

  it("opens the detail sheet instead for an open-ended disruption, which is still under way", async () => {
    matches = true;
    const openEnded = {
      ...state.commitments[0]!,
      id: "drive-mum",
      version: 2,
      title: "Driving Mum to the shops",
      location: "Westfield",
      origin: "disruption",
      disruptionOpenEnded: true,
      startsAt: "2026-08-19T01:00:00.000Z",
      endsAt: "2026-08-19T04:00:00.000Z"
    };
    await withState({ commitments: [...state.commitments, openEnded] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      fireEvent.click(screen.getByRole("button", { name: "Driving Mum to the shops, 11:00 am to 2:00 pm" }));
      expect(navigateTo).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Done, heading home" })).toBeTruthy();
    });
  });

  it("opens the Sleep sheet from a sleep block", async () => {
    matches = false;
    await withState({ sleepPlans: [sleepFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      const card = screen.getByRole("region", { name: "Day plan" });
      fireEvent.click(within(card).getByRole("button", { name: /Sleep/ }));
      expect(screen.getByRole("dialog", { name: "Sleep plan" })).toBeTruthy();
      expect(navigateTo).not.toHaveBeenCalled();
    });
  });

  it("opens Recorded today from a session block", async () => {
    matches = false;
    await withState({ completedToday: [sessionFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      const card = screen.getByRole("region", { name: "Day plan" });
      fireEvent.click(within(card).getByRole("button", { name: /Draft the essay/ }));
      const sheet = screen.getByRole("dialog", { name: "Recorded today" });
      expect(within(sheet).getByText("40 active min")).toBeTruthy();
    });
  });

  it("opens Recurring windows from an occurrence block", async () => {
    matches = false;
    await withState({ occurrences: [occurrenceFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      const card = screen.getByRole("region", { name: "Day plan" });
      fireEvent.click(within(card).getByRole("button", { name: /Morning/ }));
      expect(screen.getByRole("dialog", { name: "Recurring windows" })).toBeTruthy();
    });
  });

  /*
   * Ticking preparation off is the one capability the Preparation panel uniquely held, and it moved
   * into the sheet rather than off Today: prep for an early start is ticked the night before.
   */
  it("marks a preparation step done from the sheet, as a status-only routine_step save", async () => {
    matches = true;
    context.saveEntityCommand.mockClear();
    context.saveEntityCommand.mockResolvedValue(undefined);
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Take the bins out/ }));
    const sheet = screen.getByRole("dialog", { name: "A preparation step" });
    expect(within(sheet).getByRole("link", { name: "Open commitment" }).getAttribute("href")).toBe(
      "/commitments/dinner"
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Mark as done" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Yes, mark as done" }));
    await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
    const command = context.saveEntityCommand.mock.calls[0]![0];
    expect(command).toMatchObject({
      type: "save_entity",
      entityType: "routine_step",
      expectedVersion: prepStep.version ?? null,
      entity: {
        id: prepStep.id,
        commitmentId: "dinner",
        title: prepStep.title,
        durationMinutes: prepStep.durationMinutes,
        sequence: prepStep.sequence,
        timingRule: prepStep.timingRule,
        phase: prepStep.phase,
        status: "completed"
      }
    });
    // Status only: nothing else about the step was rewritten on its way through.
    expect(command.entity.energy).toBe(prepStep.energy);
    expect(command.entity.contexts).toEqual(prepStep.contexts);
  });
});

describe("Today page free time", () => {
  const cell = (id: string, start: string, capacityMinutes: number) => ({
    id,
    startsAt: new Date(start),
    endsAt: new Date(new Date(start).getTime() + 900_000),
    availability: "free" as const,
    energy: "medium",
    capacityMinutes
  });
  const stat = (label: string) => screen.getByText(label).previousElementSibling?.textContent;
  async function withSlots(slots: unknown[], run: () => Promise<void> | void) {
    const original = context.slots;
    context.slots = slots as unknown as typeof context.slots;
    try {
      await run();
    } finally {
      context.slots = original;
    }
  }

  it("counts only today's remaining slots as free today, not the week or what has already gone", async () => {
    matches = false;
    await withSlots(
      [
        cell("midnight", "2026-08-18T14:00:00.000Z", 0),
        cell("past", "2026-08-18T20:00:00.000Z", 15),
        cell("later", "2026-08-19T03:00:00.000Z", 30),
        cell("nextweek", "2026-08-24T03:00:00.000Z", 600)
      ],
      async () => {
        const TodayPage = await loadPage();
        render(<TodayPage />);
        expect(stat("free today")).toBe("30 m");
        expect(screen.getByText(/30 m free\./)).toBeTruthy();
        // The old usable/remaining pair is one figure now.
        expect(screen.queryByText("automatic usable minutes")).toBeNull();
        expect(screen.queryByText("remaining suitable minutes")).toBeNull();
      }
    );
  });

  it("still states the remaining figure when no slot starts before now", async () => {
    matches = false;
    await withSlots([cell("later", now.toISOString(), 15)], async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      expect(stat("free today")).toBe("15 m");
      expect(screen.queryByText("usable minutes left today")).toBeNull();
    });
  });

  it("states recorded time so far from the sessions that ended today", async () => {
    matches = false;
    await withState({ completedToday: [sessionFixture] }, async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      expect(stat("recorded so far")).toBe("40 m");
    });
  });

  it("gives a later day its whole free time, and says not known where the slots do not reach", async () => {
    matches = true;
    await withSlots([cell("tomorrow", "2026-08-20T03:00:00.000Z", 600)], async () => {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      fireEvent.click(screen.getByRole("button", { name: "Next day" }));
      expect(stat("free")).toBe("10 h");
      expect(screen.queryByText("recorded so far")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Next day" }));
      expect(stat("free")).toBe("Not known");
    });
  });
});

describe("Today page commitment links", () => {
  it("opens the commitment's own page from a commitment block", async () => {
    matches = false;
    const TodayPage = await loadPage();
    render(<TodayPage />);
    fireEvent.click(screen.getByRole("button", { name: /^12:00 pm.*Dinner and reset/ }));
    expect(navigateTo).toHaveBeenCalledWith("/commitments/dinner");
  });

  it("still opens the sleep sheet from a deep link", async () => {
    matches = false;
    window.location.hash = "#today-sleep";
    const TodayPage = await loadPage();
    render(<TodayPage />);
    const sheet = screen.getByRole("dialog", { name: "Sleep plan" });
    expect(within(sheet).getByRole("link", { name: "Correct a past night" }).getAttribute("href")).toBe("/sleep");
  });
});

describe("Today page direction", () => {
  it("says the direction was not saved when the failure carries no message of its own", async () => {
    matches = true;
    context.saveEntityCommand.mockClear();
    context.saveEntityCommand.mockRejectedValue("nope");
    try {
      const TodayPage = await loadPage();
      render(<TodayPage />);
      fireEvent.click(screen.getByRole("button", { name: /^Direction for today/ }));
      fireEvent.click(screen.getByRole("button", { name: "Save today’s direction" }));
      const sheet = screen.getByRole("dialog", { name: "Direction for today" });
      const alert = await within(sheet).findByRole("alert");
      expect(alert.textContent).toBe("Today's direction was not saved.");
      // Focus moves to the error, inside the sheet, so Escape still reaches it after a failed save. The
      // move is an effect after the error is drawn, so the alert can be found a moment before it has focus.
      await vi.waitFor(() => expect(document.activeElement).toBe(alert));
      // The error belongs to the sheet it came from: closing it clears the error, so reopening starts clean.
      fireEvent.click(within(sheet).getByRole("button", { name: "Close Direction for today" }));
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^Direction for today/ }));
      expect(within(screen.getByRole("dialog", { name: "Direction for today" })).queryByRole("alert")).toBeNull();
    } finally {
      context.saveEntityCommand.mockResolvedValue(undefined);
    }
  });
});

// Finding 31(b): the daily plan's desired wins used to seed only once, on mount, from `[ready]`
// alone — a page left open past midnight kept yesterday's wins in state while `todayKey` moved on,
// so saving wrote them under the new day's key. They must be keyed together.
describe("Today page daily plan across midnight", () => {
  it("drops yesterday's desired wins before they can be saved under today's date", async () => {
    matches = true;
    const overnightState = {
      ...state,
      dailyPlan: {
        id: "daily-plan-2026-08-19",
        localDate: "2026-08-19",
        desiredActionIds: ["networking-section-one"],
        recoverySkipped: false,
        deferredItems: [],
        version: 3
      }
    };
    context.state = overnightState;
    context.saveEntityCommand.mockClear();
    context.saveEntityCommand.mockResolvedValue(undefined);
    try {
      const { default: TodayPage } = await import("./page");
      render(<TodayPage />);
      fireEvent.click(screen.getByRole("button", { name: /^Direction for today/ }));
      const sheet = screen.getByRole("dialog", { name: "Direction for today" });
      expect(within(sheet).queryByText("No desired wins chosen yet.")).toBeNull();

      // The page stays open past midnight in the seed zone; the clock ticks into the next local day.
      act(() => {
        freezeClock(new Date("2026-08-20T00:00:00.000Z"));
      });
      expect(within(sheet).getByText("No desired wins chosen yet.")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save today’s direction" }));
      await vi.waitFor(() => expect(context.saveEntityCommand).toHaveBeenCalledTimes(1));
      const command = context.saveEntityCommand.mock.calls[0]![0];
      expect(command.entity).toMatchObject({ localDate: "2026-08-20", desiredActionIds: [] });
    } finally {
      context.state = state;
      freezeClock(now);
    }
  });
});
