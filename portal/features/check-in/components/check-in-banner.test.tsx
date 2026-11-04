// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen } from "@/test/render";
import type { CheckInPrompt } from "@/state/portal-provider";
import { CheckInBanner } from "./check-in-banner";

// 10:15 am local, matching a captured prompt — a prompt about a slot 37 minutes earlier.
const now = new Date("2026-09-04T00:15:00.000Z");
const state = createSeedState(now);
freezeClock(now);

let context: Record<string, unknown>;
vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => context };
});

function checkIn(overrides: Partial<CheckInPrompt> = {}): CheckInPrompt {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    version: 3,
    status: "pending",
    slotAt: now.toISOString(),
    directiveKind: "deliverable",
    directiveTitle: "Assessment 3 – frame assembly and detail drawings",
    ...overrides
  };
}

function contextWith(pendingCheckIn: CheckInPrompt | null, dismissPendingCheckIn = vi.fn()) {
  context = { state, pendingCheckIn, dismissPendingCheckIn };
  return context;
}

function stubFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ state: {} }) }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("CheckInBanner", () => {
  it("renders nothing when there is no pending check-in", () => {
    contextWith(null);
    const { container } = render(<CheckInBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("asks about the present tense, naming the directive, for a live pending slot", () => {
    contextWith(checkIn({ status: "pending", slotAt: now.toISOString() }));
    render(<CheckInBanner />);
    expect(screen.getByText("Still on Assessment 3 – frame assembly and detail drawings?")).toBeTruthy();
  });

  it("offers the hourly photo only when the check-in asks for one", () => {
    contextWith(checkIn());
    const { unmount } = render(<CheckInBanner />);
    expect(screen.queryByText("Add a photo")).toBeNull();
    unmount();
    contextWith(checkIn({ photoRequested: true }));
    render(<CheckInBanner />);
    expect(screen.getByText("Add a photo").getAttribute("href")).toBe(
      "/photo-checkins?checkIn=11111111-1111-1111-1111-111111111111"
    );
  });

  // The catch-up prompt named only the time, never what the plan had the user on,
  // making the question unanswerable without knowing what "on track" would even mean.
  it("names what the plan had the user on, in the catch-up prompt", () => {
    const slotAt = new Date(now.getTime() - 37 * 60_000).toISOString();
    contextWith(checkIn({ status: "unknown", slotAt }));
    render(<CheckInBanner />);
    expect(
      screen.getByText(
        "What were you doing around 9:38 am? At the time, the plan had you on: Assessment 3 – frame assembly and detail drawings."
      )
    ).toBeTruthy();
  });

  it("falls back to only the time when the check-in recorded no directive title", () => {
    const slotAt = new Date(now.getTime() - 37 * 60_000).toISOString();
    contextWith(checkIn({ status: "unknown", slotAt, directiveTitle: "" }));
    render(<CheckInBanner />);
    expect(screen.getByText("What were you doing around 9:38 am?")).toBeTruthy();
  });

  // A prompt about a slot more than 5 minutes ago offers a "Not sure" option.
  it("hides Not sure for a slot inside the 5-minute-fresh window", () => {
    const slotAt = new Date(now.getTime() - 4 * 60_000).toISOString();
    contextWith(checkIn({ status: "pending", slotAt }));
    render(<CheckInBanner />);
    expect(screen.queryByRole("button", { name: "Not sure" })).toBeNull();
  });

  it("offers Not sure once the slot is 5 minutes old or older, whether or not it caught up", () => {
    const slotAt = new Date(now.getTime() - 5 * 60_000).toISOString();
    contextWith(checkIn({ status: "pending", slotAt }));
    render(<CheckInBanner />);
    expect(screen.getByRole("button", { name: "Not sure" })).toBeTruthy();
  });

  it("offers Not sure for a stale catch-up prompt, like the 37-minute one reported", () => {
    const slotAt = new Date(now.getTime() - 37 * 60_000).toISOString();
    contextWith(checkIn({ status: "unknown", slotAt }));
    render(<CheckInBanner />);
    expect(screen.getByRole("button", { name: "Not sure" })).toBeTruthy();
  });

  it("answers Not sure as its own status, distinct from on_track or deviated, and dismisses", async () => {
    stubFetchOk();
    const dismissPendingCheckIn = vi.fn();
    const slotAt = new Date(now.getTime() - 37 * 60_000).toISOString();
    contextWith(checkIn({ status: "unknown", slotAt }), dismissPendingCheckIn);
    render(<CheckInBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Not sure" }));
    await vi.waitFor(() => expect(dismissPendingCheckIn).toHaveBeenCalledTimes(1));
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("/api/commands/check-in");
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "answer_check_in",
      checkInId: "11111111-1111-1111-1111-111111111111",
      status: "unknown",
      answerSource: "in_app_banner"
    });
  });

  it("still answers On track and Something else as before", async () => {
    stubFetchOk();
    const dismissPendingCheckIn = vi.fn();
    contextWith(checkIn({ status: "pending", slotAt: now.toISOString() }), dismissPendingCheckIn);
    render(<CheckInBanner />);
    fireEvent.click(screen.getByRole("button", { name: "On track" }));
    await vi.waitFor(() => expect(dismissPendingCheckIn).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      ((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "on_track" });
  });

  // Behaviour contract, "Check-in sampling": once answered, a check-in "does not reappear" — every one
  // of the three answers dismisses the banner the same way. The other two are covered above; this is
  // "Something else", the one answer that opens a sheet first rather than firing immediately.
  it("refuses a bare Something else, naming what the plan needs, and posts nothing", () => {
    stubFetchOk();
    const dismissPendingCheckIn = vi.fn();
    contextWith(checkIn({ status: "pending", slotAt: now.toISOString() }), dismissPendingCheckIn);
    render(<CheckInBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Still needed: what you are doing, until when/);
    expect(fetch).not.toHaveBeenCalled();
    expect(dismissPendingCheckIn).not.toHaveBeenCalled();
  });

  it("records the disruption, then answers the slot, and dismisses", async () => {
    stubFetchOk();
    const dismissPendingCheckIn = vi.fn();
    const home = { id: "home", name: "Home", kind: "location", status: "active" };
    const phone = { id: "cap-phone", name: "Phone", kind: "capability", status: "active" };
    context = {
      state: { ...state, conditionDefinitions: [home, phone] },
      pendingCheckIn: checkIn({ status: "pending", slotAt: now.toISOString() }),
      dismissPendingCheckIn,
      acceptServerState: vi.fn()
    };
    render(<CheckInBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByLabelText(/What are you doing\?/), { target: { value: "Kids" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, all of me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(dismissPendingCheckIn).toHaveBeenCalledTimes(1));
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe("/api/commands/pulse-disruption");
    expect(calls[1]![0]).toBe("/api/commands/check-in");
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toMatchObject({ status: "deviated" });
  });
});

describe("CheckInBanner while the pulse is unknown", () => {
  const unknownPulse: NonNullable<typeof state.pulse> = {
    state: "unknown",
    since: now.toISOString(),
    reason: "unconfirmed",
    private: false,
    doing: { kind: "action", id: "a", title: "Write report" },
    shares: {
      today: { onPercent: null, countedMinutes: 0 },
      days7: { onPercent: null, countedMinutes: 0 },
      days30: { onPercent: null, countedMinutes: 0 }
    }
  };
  const withPulse = (pending: CheckInPrompt | null) => {
    context = { state: { ...state, pulse: unknownPulse }, pendingCheckIn: pending, dismissPendingCheckIn: vi.fn() };
  };

  it("asks 'Still doing X?' with Yes and Something else, and Yes is the on-track answer", async () => {
    stubFetchOk();
    withPulse(checkIn({ status: "unknown", slotAt: new Date(now.getTime() - 40 * 60_000).toISOString() }));
    render(<CheckInBanner />);
    expect(screen.getByText("Still doing Write report?")).toBeTruthy();
    expect(screen.queryByText("Not sure")).toBeNull();
    expect(screen.getByText("Something else")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "answer_check_in", status: "on_track" });
  });

  it("says when the saved title was the plan when the pulse carries no live activity", () => {
    const { doing: _doing, ...noDoing } = unknownPulse;
    context = {
      state: { ...state, pulse: noDoing },
      pendingCheckIn: checkIn({ status: "unknown", slotAt: new Date(now.getTime() - 40 * 60_000).toISOString() }),
      dismissPendingCheckIn: vi.fn()
    };
    render(<CheckInBanner />);
    expect(screen.getByText(/^Still doing .+\? The plan had you on it at .+\.$/)).toBeTruthy();
  });

  it("opens the deviation flow from Something else", () => {
    withPulse(checkIn());
    render(<CheckInBanner />);
    fireEvent.click(screen.getByText("Something else"));
    expect(screen.getByText("What was it instead?")).toBeTruthy();
  });

  it("says what counts as contact when no check-in is waiting", () => {
    withPulse(null);
    render(<CheckInBanner />);
    expect(screen.getByText(/Still doing Write report\?/)).toBeTruthy();
    expect(screen.getByText(/Start, finish or pause something/)).toBeTruthy();
  });

  it("hides the unknown wording while a recorded disruption is in force", () => {
    context = {
      state: {
        ...state,
        pulse: {
          ...unknownPulse,
          disruption: {
            doing: "Kids",
            until: "2099-01-01T00:00:00.000Z",
            locationId: "home",
            contexts: ["c"],
            exclusive: true
          }
        }
      },
      pendingCheckIn: checkIn({ status: "unknown" }),
      dismissPendingCheckIn: vi.fn()
    };
    render(<CheckInBanner />);
    expect(screen.queryByText(/Still doing/)).toBeNull();
    expect(screen.queryByText("Something else")).toBeNull();
  });
});
