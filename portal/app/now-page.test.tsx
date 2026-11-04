// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanForecastResponse, PrepPace } from "@openrhen/contracts";
import { fireEvent, render, screen, within } from "@/test/render";
import { createSeedState, type ActiveSession, type StoredCommitment } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { registerPortalExtension } from "@/state/portal-extensions";
import type {
  ClientCandidate,
  ClientProtectedCommitment,
  ClientRecommendation,
  CheckInPrompt
} from "@/state/portal-provider";
// A static import, not a dynamic one inside each `it()`. `vi.mock` below is hoisted above every
// import in this file (Vitest's usual transform), so this still gets the mocked provider — and
// paying the transform cost for `./page`'s large import graph once, during the file's own import
// phase, keeps it off each test's individual timeout budget. A dynamic `await import(...)` inside
// the test body used to charge that same cost against the default per-test timeout instead; under
// machine load the transform could run long enough to blow past it, the test would be marked timed
// out while the import (and the `render` after it) kept running in the background, and that
// abandoned render would land — and stay mounted, since its own test's `afterEach` cleanup had
// already fired before it arrived — during whichever test happened to be running by the time it
// finally resolved. That is what produced the "multiple elements with role heading" failure in the
// second test: two `NowPage` trees mounted in the same document at once.
import NowPage from "./page";

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const action = state.actions[0]!;
const primary: ClientCandidate = {
  action,
  eligible: true,
  exclusionReasons: [],
  recommendedMinutes: 30,
  totalScore: 10,
  scoreComponents: { deadline: 4 }
} as ClientCandidate;
const recommendation: ClientRecommendation = {
  primary,
  alternatives: [],
  candidates: [primary],
  headline: action.title,
  explanation: "It fits the window.",
  evidence: []
};

// The page reads everything through the portal context, so a partial context stands in for the
// provider; only the fields this composition touches are given real values.
const context = {
  state,
  ready: true,
  saving: false,
  recommendation,
  forecasts: [],
  slots: [],
  currentDirective: null,
  upcomingDirectives: [],
  continuation: null,
  bannerText: "",
  replay: null,
  live: true,
  pendingCheckIn: null as CheckInPrompt | null,
  dismissPendingCheckIn: vi.fn(),
  startCurrent: vi.fn(),
  startAlternative: vi.fn(),
  blockRecommended: vi.fn(),
  pauseOrResume: vi.fn(),
  requestFeedback: vi.fn(),
  finishSession: vi.fn(),
  saveEntityCommand: vi.fn(),
  runActivityCommand: vi.fn(),
  planHealth: null,
  extensions: {}
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));
// The welcome-back data is its own hook with its own tests; here only its placement on Now matters.
const welcomeBack = {
  show: false,
  awaySince: null as string | null,
  rows: [] as { key: "catch-up" | "needs" | "agent-changes" | "inbox"; label: string; count: number; href: string }[],
  markSeen: vi.fn(),
  agentChangesSinceLooked: 0,
  agentChangesNeverLooked: false
};
vi.mock("@/features/welcome-back/use-welcome-back", () => ({ useWelcomeBack: () => welcomeBack }));
// The page reads the clock from the store rather than the context, so it is frozen at the same instant.
freezeClock(now);

function checkIn(): CheckInPrompt {
  return {
    id: "check-in-1",
    version: 1,
    status: "pending",
    slotAt: now.toISOString(),
    directiveKind: "action",
    directiveTitle: action.title
  };
}

const runningActionSession: ActiveSession = {
  id: "session-1",
  actionId: action.id,
  status: "running",
  startedAt: new Date(now.getTime() - 600_000).toISOString(),
  plannedEndAt: new Date(now.getTime() + 1_200_000).toISOString(),
  plannedMinutes: 30,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 600
};

// The seed state's one confirmed commitment — reused below as "the protected commitment gone late",
// so admitting it never requires adding a second commitment row (`resolveNowActivity`'s `protectedInfo`
// only ever admits a commitment already present, confirmed, in `state.commitments`).
const dinner = state.commitments.find((item) => item.id === "dinner")!;

function lateDinnerCommitment(): ClientProtectedCommitment {
  const startsAt = new Date(dinner.startsAt);
  const endsAt = new Date(dinner.endsAt);
  return {
    id: dinner.id,
    title: dinner.title,
    phase: "setup",
    startsAt,
    endsAt,
    protectedStartAt: startsAt,
    protectedEndAt: endsAt,
    phaseStartsAt: startsAt,
    phaseEndsAt: endsAt,
    late: true
  };
}

const behindPrepPace: PrepPace = {
  commitmentId: dinner.id,
  commitmentTitle: dinner.title,
  commitmentStartsAt: dinner.startsAt,
  requiredMinutes: 30,
  availableMinutes: 10,
  minutesBehind: 20,
  status: "behind"
};

/** A minimal-but-complete engine result, matching every field `planForecastResponseSchema` requires —
 * the same shape `features/now/now-model.test.ts` uses, since `model.prepPace` reads straight off
 * `state.planning.result.prepPace`, never from the `recommendation` this file mocks separately. */
function planningResultWithPrepPace(prepPace: PrepPace): PlanForecastResponse {
  return {
    contractVersion: "1",
    requestId: "8fe5bba7-e436-429d-8011-67467b3ec55e",
    inputVersion: "abc123",
    engineVersion: "1.5.0",
    calculatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats: [],
      stepPlacements: []
    },
    schedule: {},
    recommendation: {},
    currentDirective: { kind: "none", title: "Nothing fits", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null,
    softPlacements: [],
    prepPace
  };
}

// A renegotiate-tier disruption: origin/landedAt/live-window match what `activeDisruption`
// (features/disruptions/disruption-summary.ts) requires, and the fixture is otherwise the same shape
// `renegotiation-panel.test.tsx` already proves works with `RenegotiationPanel`.
const disruptionCommitment: StoredCommitment = {
  id: "storm-disruption",
  title: "Storm cleanup",
  startsAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
  endsAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  origin: "disruption",
  disruptionSource: "family",
  landedAt: new Date(now.getTime() - 20 * 60_000).toISOString()
};

function stubRenegotiateFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          available: true,
          moved: [],
          dropped: [],
          added: [],
          sleepShiftMinutes: 0,
          newlyDisplaced: [
            { targetId: "unresolvable-target", firstPlannedAt: new Date(now.getTime() - 3_600_000).toISOString() }
          ]
        })
    })
  );
}

let matches = false;
beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
  context.pendingCheckIn = null;
  context.upcomingDirectives = [];
  context.state = state;
  context.recommendation = recommendation;
  state.activeSession = null;
  state.commitments = [dinner];
  delete state.planning;
  vi.unstubAllGlobals();
});

const pulseBase = {
  since: now.toISOString(),
  private: false,
  shares: {
    today: { onPercent: null, countedMinutes: 0 },
    days7: { onPercent: null, countedMinutes: 0 },
    days30: { onPercent: null, countedMinutes: 0 }
  }
};

describe("Now page and the pulse", () => {
  afterEach(() => {
    delete (state as { pulse?: unknown }).pulse;
  });

  it("shows the re-entry sheet in place of the directive while the pulse is lapsed, and no welcome-back banner", async () => {
    state.pulse = { ...pulseBase, state: "off", reason: "lapsed", offReason: "lapsed" };
    Object.assign(welcomeBack, {
      show: true,
      rows: [{ key: "inbox", label: "5 waiting in Inbox", count: 5, href: "/inbox" }]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lapsed: true,
          review: {
            tier: "none",
            lastConfirmedAt: null,
            gapMinutes: 90,
            reviewable: 0,
            lapsing: 0,
            days: [],
            projects: [],
            entries: []
          },
          choices: { places: [{ id: "home", name: "Home" }], contexts: [] }
        })
      }))
    );
    try {
      render(<NowPage />);
      expect(await screen.findByText(/Let's get you back on plan/)).toBeTruthy();
      expect(screen.queryByText(action.title)).toBeNull();
      expect(screen.queryByText(/Welcome back\. You've been away/)).toBeNull();
      expect(screen.getByText("Lost track · catch up")).toBeTruthy();
    } finally {
      Object.assign(welcomeBack, { show: false, rows: [] });
    }
  });

  it("keeps a running session's panel reachable under the re-entry sheet while the pulse is lapsed", async () => {
    state.pulse = { ...pulseBase, state: "off", reason: "lapsed", offReason: "lapsed" };
    state.activeSession = runningActionSession;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lapsed: true,
          review: {
            tier: "none",
            lastConfirmedAt: null,
            gapMinutes: 90,
            reviewable: 0,
            lapsing: 0,
            days: [],
            projects: [],
            entries: []
          },
          choices: { places: [], contexts: [] }
        })
      }))
    );
    const { container } = render(<NowPage />);
    expect(await screen.findByText(/Let's get you back on plan/)).toBeTruthy();
    expect(container.querySelector(".action-bar")).not.toBeNull();
  });

  it("keeps the directive and says 'not sure' on the chip while the pulse is unknown", () => {
    state.pulse = { ...pulseBase, state: "unknown", reason: "unconfirmed" };
    render(<NowPage />);
    expect(screen.getByText("Not sure what you're doing")).toBeTruthy();
    expect(screen.getAllByText(action.title).length).toBeGreaterThan(0);
  });
});

describe("Now page composition", () => {
  it("greets someone back from a break above the hero, with Catch up going straight to what changed", () => {
    Object.assign(welcomeBack, {
      show: true,
      awaySince: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      rows: [{ key: "agent-changes", label: "4 changes made for you", count: 4, href: "/review" }]
    });
    try {
      render(<NowPage />);
      const banner = screen.getByText(/^Welcome back\. You've been away since /);
      const hero = document.querySelector("[data-now-hero]") ?? document.querySelector(".now-hero");
      expect(hero && banner.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole("link", { name: "Catch up" }).getAttribute("href")).toBe("/review");
    } finally {
      Object.assign(welcomeBack, { show: false, awaySince: null, rows: [] });
    }
  });

  it("says how many agent changes came in since the list was looked at, and links to it", () => {
    welcomeBack.agentChangesSinceLooked = 3;
    try {
      render(<NowPage />);
      expect(screen.getByText("3 agent changes since you looked.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/review#agent-changes");
    } finally {
      welcomeBack.agentChangesSinceLooked = 0;
    }
  });

  it('drops the "since" on a device that has never looked at the list', () => {
    Object.assign(welcomeBack, { agentChangesSinceLooked: 4, agentChangesNeverLooked: true });
    try {
      render(<NowPage />);
      expect(screen.getByText(/4 agent changes\s+to look over\./)).toBeTruthy();
    } finally {
      Object.assign(welcomeBack, { agentChangesSinceLooked: 0, agentChangesNeverLooked: false });
    }
  });

  it("leaves the agent changes count to the welcome-back banner when that already says it", () => {
    Object.assign(welcomeBack, {
      show: true,
      agentChangesSinceLooked: 2,
      rows: [{ key: "agent-changes", label: "2 changes by agents while you were away", count: 2, href: "/review" }]
    });
    try {
      render(<NowPage />);
      expect(screen.queryByText(/since you looked/)).toBeNull();
    } finally {
      Object.assign(welcomeBack, { show: false, rows: [], agentChangesSinceLooked: 0 });
    }
  });

  it("on a phone puts the situation chip line above the directive, and docks the directive's actions in the hero", () => {
    matches = false;
    const { container } = render(<NowPage />);
    const heading = screen.getByRole("heading", { level: 1, name: action.title });
    const chip = screen.getByRole("button", { name: /^Your situation:/ });
    // The one line above the hero: date, clock and plan status, then the situation chip.
    expect(chip.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("NOW")).toBeNull();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.closest(".action-bar > .actions")).not.toBeNull();
    expect(container.querySelector(".now-hero.now-directive .action-bar")).not.toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(container.querySelector(".now-secondary .context-now")).toBeNull();
  });

  it("on a desk uses the same chip line above the hero, and keeps Up next and From people in the aside", () => {
    matches = true;
    context.upcomingDirectives = [
      { kind: "action", targetId: "room-floor", title: "Sort the bedroom floor", recommendedMinutes: 20 }
    ] as never;
    const { container } = render(<NowPage />);
    const hero = container.querySelector(".now-hero")!;
    expect(hero.hasAttribute("data-now-hero")).toBe(true);
    expect(hero.contains(screen.getByRole("heading", { level: 1, name: action.title }))).toBe(true);
    const chip = screen.getByRole("button", { name: /^Your situation:/ });
    expect(chip.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const aside = container.querySelector("aside")!;
    expect(hero.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside.contains(screen.getByRole("heading", { name: "Up next" }))).toBe(true);
    expect(hero.contains(aside)).toBe(false);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(container.querySelector(".now-secondary .context-now")).toBeNull();
  });

  it("puts a registered extension's banner below the hero, in the side column", () => {
    matches = true;
    registerPortalExtension({ id: "example-banner", Banner: () => <h2>From people</h2> });
    const { container } = render(<NowPage />);
    const strip = screen.getByRole("heading", { name: "From people" });
    expect(
      container.querySelector(".now-hero")!.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.querySelector("aside")!.contains(strip)).toBe(true);
  });

  it("offers first setup in the hero to someone brand new, instead of an empty page", () => {
    matches = false;
    context.state = {
      ...state,
      actions: [],
      settings: { ...state.settings, setupCompletedAt: undefined }
    } as typeof state;
    context.recommendation = { ...recommendation, primary: null, candidates: [], headline: "No plan yet" };
    render(<NowPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Let's set up your plan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start setup" }).getAttribute("href")).toBe("/setup");
  });

  it("holds the hero's shape while a first plan is being worked out", () => {
    matches = false;
    context.state = {
      ...state,
      settings: { ...state.settings, setupCompletedAt: now.toISOString() },
      planning: { status: "pending" }
    } as typeof state;
    context.recommendation = { ...recommendation, primary: null, candidates: [], headline: "No plan yet" };
    const { container } = render(<NowPage />);
    expect(screen.getByText("Working out your plan…").getAttribute("role")).toBe("status");
    expect(container.querySelector(".now-hero.now-directive .hero-skeleton")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("marks the live dot on while the SSE connection is up, at the head of the date line", () => {
    matches = false;
    render(<NowPage />);
    const dot = screen.getByLabelText("Live updates connected");
    expect(dot.getAttribute("data-live")).toBe("true");
    // Same line as the date, the clock and the plan status.
    expect(dot.closest("p")?.textContent).toMatch(/·/);
  });

  it("marks the live dot off and says updates are polling when the SSE connection is down", () => {
    matches = false;
    context.live = false;
    try {
      render(<NowPage />);
      expect(screen.getByLabelText("Live updates off, polling").getAttribute("data-live")).toBe("false");
    } finally {
      context.live = true;
    }
  });

  it("keeps Something came up under the hero when another panel outranks the recommendation", () => {
    // A recommendation exists, but the protected commitment owns the hero, so its Something else sheet
    // (which normally carries this) is not on the page.
    context.recommendation = { ...recommendation, protectedCommitment: lateDinnerCommitment() };
    render(<NowPage />);
    expect(screen.queryByRole("button", { name: "Something else…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Something came up" })).toBeTruthy();
  });

  describe("after Switch to", () => {
    const loose = context as unknown as Record<string, unknown>;
    afterEach(() => {
      context.state = state;
      delete loose.switchPending;
      delete loose.switchedFrom;
      context.startCurrent.mockClear();
      context.startAlternative.mockClear();
    });

    it("offers the new primary in Something else and starts it with start, not as an alternative", () => {
      loose.switchPending = true;
      loose.switchedFrom = "some-other-task";
      // Choosing a row needs a plan that is current.
      context.state = {
        ...state,
        planning: { status: "current", lastSuccessfulAt: now.toISOString(), validUntil: "2099-01-01T00:00:00.000Z" }
      } as typeof state;
      render(<NowPage />);
      const dialog = screen.getByRole("dialog", { name: "Something else" });
      fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(action.title) }));
      expect(context.startCurrent).toHaveBeenCalledTimes(1);
      expect(context.startAlternative).not.toHaveBeenCalled();
    });

    it("does not offer the task that was just stopped", () => {
      loose.switchPending = true;
      loose.switchedFrom = action.id;
      render(<NowPage />);
      const dialog = screen.getByRole("dialog", { name: "Something else" });
      expect(within(dialog).queryByRole("button", { name: new RegExp(action.title) })).toBeNull();
    });
  });

  it("does not offer the stopped task among the alternatives either", () => {
    const loose = context as unknown as Record<string, unknown>;
    const stopped = state.actions[1]!;
    const stoppedCandidate = { ...primary, action: stopped } as ClientCandidate;
    context.recommendation = { ...recommendation, alternatives: [stoppedCandidate] };
    loose.switchPending = true;
    loose.switchedFrom = stopped.id;
    try {
      render(<NowPage />);
      const dialog = screen.getByRole("dialog", { name: "Something else" });
      expect(within(dialog).getByRole("button", { name: new RegExp(action.title) })).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: new RegExp(stopped.title) })).toBeNull();
    } finally {
      context.recommendation = recommendation;
      delete loose.switchPending;
      delete loose.switchedFrom;
    }
  });

  it("leaves Something came up to the recommendation's own sheet when the recommendation is the hero", () => {
    render(<NowPage />);
    expect(screen.getByRole("button", { name: "Something else…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Something came up" })).toBeNull();
  });

  it("puts a pending check-in above the directive on the no-session view", () => {
    matches = false;
    context.pendingCheckIn = checkIn();
    const { container } = render(<NowPage />);
    const banner = container.querySelector(".check-in-banner");
    const heading = screen.getByRole("heading", { level: 1, name: action.title });
    expect(banner).not.toBeNull();
    expect(banner!.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The banner used to be composed only into the no-session (recommendation) view — a running
  // session's four early-return branches never mounted it at all, so "Still on X?" simply never
  // appeared while a session was actually in progress, the one moment it matters most.
  it("also puts a pending check-in above the panel for a currently running session", () => {
    matches = false;
    context.pendingCheckIn = checkIn();
    state.activeSession = runningActionSession;
    const { container } = render(<NowPage />);
    const banner = container.querySelector(".check-in-banner");
    const actionBar = container.querySelector(".action-bar");
    expect(banner).not.toBeNull();
    expect(actionBar).not.toBeNull();
    expect(banner!.compareDocumentPosition(actionBar!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// A different commitment from whichever one the session below tracks (or no commitment at all), so
// admitting it as "late" never depends on which branch is under test.
const runningCommitmentSession: ActiveSession = {
  id: "session-commitment",
  actionId: "team-standup",
  targetType: "fixed_commitment",
  targetId: "team-standup",
  status: "running",
  startedAt: new Date(now.getTime() - 300_000).toISOString(),
  plannedEndAt: new Date(now.getTime() + 900_000).toISOString(),
  plannedMinutes: 20,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 300
};

const runningDeliverableSession: ActiveSession = {
  id: "session-deliverable",
  actionId: "draft-outline",
  targetType: "deliverable",
  targetId: "draft-outline",
  targetTitle: "Draft outline",
  status: "running",
  startedAt: new Date(now.getTime() - 300_000).toISOString(),
  plannedEndAt: new Date(now.getTime() + 900_000).toISOString(),
  plannedMinutes: 20,
  remainingBeforeMinutes: 90,
  activeElapsedSeconds: 300
};

const feedbackActionSession: ActiveSession = {
  ...runningActionSession,
  id: "session-feedback",
  status: "feedback"
};

/**
 * The audit found: `PrepPaceBanner`, `RenegotiationPanel` and a protected commitment gone
 * `late` are computed unconditionally regardless of `session` (`model.prepPace`, `disruption` and
 * `model.protectedCommitment` do not branch on it), but every one of the four running-session
 * branches used to early-return before any of the three was ever mounted. Each case here arms all
 * three signals plus a pending check-in — the fourth banner already covered by an existing test above
 * for two of the four branches, but never for the sleep/routine/commitment or deliverable branches,
 * and never at all for the feedback branch.
 */
describe("Now page composition — session-independent banners during a running session", () => {
  beforeEach(() => {
    matches = false;
    context.pendingCheckIn = checkIn();
    context.recommendation = { ...recommendation, protectedCommitment: lateDinnerCommitment() };
    state.planning = {
      status: "current",
      lastSuccessfulAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
      result: planningResultWithPrepPace(behindPrepPace)
    };
    state.commitments = [dinner, disruptionCommitment];
    stubRenegotiateFetch();
  });

  async function expectAllFourBanners(container: HTMLElement) {
    expect(container.querySelector(".check-in-banner")).not.toBeNull();
    expect(container.querySelector(".prep-pace-banner")).not.toBeNull();
    expect(screen.getByText(new RegExp(`Running late for ${dinner.title}`))).toBeTruthy();
    await vi.waitFor(() => expect(container.querySelector(".renegotiation-panel")).not.toBeNull());
  }

  it("surfaces them on the sleep/routine/fixed-commitment session branch", async () => {
    state.activeSession = runningCommitmentSession;
    const { container } = render(<NowPage />);
    await expectAllFourBanners(container);
  });

  it("surfaces them on the deliverable session branch", async () => {
    state.activeSession = runningDeliverableSession;
    const { container } = render(<NowPage />);
    await expectAllFourBanners(container);
  });

  // This branch alone had no `CheckInBanner` at all, on top of the
  // structural gap every session branch shared.
  it("surfaces them on the feedback branch", async () => {
    state.activeSession = feedbackActionSession;
    const { container } = render(<NowPage />);
    await expectAllFourBanners(container);
  });

  it("surfaces them on the action session branch", async () => {
    state.activeSession = runningActionSession;
    const { container } = render(<NowPage />);
    await expectAllFourBanners(container);
  });

  // The one exception: a commitment the running session is itself tracking already has its own panel
  // saying so, so the compact banner must not also say it.
  it("does not duplicate the late banner when the running session is itself tracking that commitment", () => {
    state.activeSession = { ...runningCommitmentSession, targetId: dinner.id, actionId: dinner.id };
    const { container } = render(<NowPage />);
    expect(container.querySelector(".late-commitment-banner")).toBeNull();
  });
});

/**
 * The session reconciliation design note — the reconciliation branch replaces the deliverable
 * session/checkpoint panel once a running deliverable session's trail holds three or more
 * consecutive unanswered check-ins, and never for a paused one or one below that count.
 */
describe("Now page composition — session reconciliation", () => {
  const trailBody = {
    rows: [
      {
        id: "check-in-a",
        slotAt: new Date(now.getTime() - 3 * 3_600_000).toISOString(),
        directiveTitle: "Draft outline"
      },
      {
        id: "check-in-b",
        slotAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
        directiveTitle: "Draft outline"
      },
      {
        id: "check-in-c",
        slotAt: new Date(now.getTime() - 1 * 3_600_000).toISOString(),
        directiveTitle: "Draft outline"
      }
    ],
    sleepStarts: [] as string[]
  };

  function stubCheckInFetches() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/check-ins/trail"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve(trailBody) });
        if (url === "/api/commands/check-in")
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: {} }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      })
    );
  }

  function unverifiedDeliverableSession(unansweredCheckIns: number): ActiveSession {
    const segmentStartedAt = new Date(now.getTime() - 4 * 3_600_000).toISOString();
    return {
      ...runningDeliverableSession,
      id: "session-unverified",
      segmentStartedAt,
      // Coincides with segmentStartedAt — the motivating case: no on-track answer ever moved
      // `lastVerifiedAt` past where the open segment began.
      lastVerifiedAt: segmentStartedAt,
      unansweredCheckIns
    };
  }

  beforeEach(() => {
    matches = false;
    stubCheckInFetches();
  });

  it("shows the ordinary session panel, not reconciliation, at only two unanswered slots", () => {
    state.activeSession = unverifiedDeliverableSession(2);
    const { container } = render(<NowPage />);
    expect(container.querySelector(".reconciliation-panel")).toBeNull();
    expect(screen.getByText("Deliverable in progress")).toBeTruthy();
  });

  it("replaces the checkpoint/session panel with reconciliation at three unanswered slots", async () => {
    state.activeSession = unverifiedDeliverableSession(3);
    const { container } = render(<NowPage />);
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-ladder")).not.toBeNull());
    expect(screen.queryByText("Deliverable in progress")).toBeNull();
    expect(container.querySelectorAll(".reconciliation-ladder li")).toHaveLength(3);
  });

  it("suppresses the check-in banner while reconciliation is shown", async () => {
    context.pendingCheckIn = checkIn();
    state.activeSession = unverifiedDeliverableSession(3);
    const { container } = render(<NowPage />);
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-panel")).not.toBeNull());
    expect(container.querySelector(".check-in-banner")).toBeNull();
  });

  it("keeps the prep-pace and running-late banners above the reconciliation panel", async () => {
    context.recommendation = { ...recommendation, protectedCommitment: lateDinnerCommitment() };
    state.planning = {
      status: "current",
      lastSuccessfulAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
      result: planningResultWithPrepPace(behindPrepPace)
    };
    state.activeSession = unverifiedDeliverableSession(3);
    const { container } = render(<NowPage />);
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-panel")).not.toBeNull());
    const prepPace = container.querySelector(".prep-pace-banner");
    const panel = container.querySelector(".reconciliation-panel");
    expect(prepPace).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(prepPace!.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(new RegExp(`Running late for ${dinner.title}`))).toBeTruthy();
  });

  it("'I was working the whole time' answers the trail and returns to the ordinary session panel", async () => {
    state.activeSession = unverifiedDeliverableSession(3);
    const { container } = render(<NowPage />);
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-ladder")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "I was working the whole time" }));
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-panel")).toBeNull());
    expect(screen.getByText("Deliverable in progress")).toBeTruthy();
    const checkInCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String(call[0]) === "/api/commands/check-in"
    );
    expect(checkInCall).toBeTruthy();
    const body = JSON.parse(checkInCall![1].body as string);
    expect(body.type).toBe("answer_check_ins");
    expect(body.tail).toEqual({ status: "on_track" });
    expect(body.checkInIds).toEqual(["check-in-a", "check-in-b", "check-in-c"]);
  });

  it("fills the end picker on the planning wall clock the ladder is labelled in, not the device's", async () => {
    const planningTimezone = state.settings.timezone;
    // A planning zone no test machine runs in, so a picker that read the device's zone would fail.
    state.settings.timezone = "Pacific/Auckland";
    try {
      state.activeSession = unverifiedDeliverableSession(3);
      const { container } = render(<NowPage />);
      await vi.waitFor(() => expect(container.querySelector(".reconciliation-ladder")).not.toBeNull());
      // The last rung is 09:00Z: 9:00 pm in Auckland, and its label says so.
      const rung = screen.getByRole("button", { name: /9:00.*pm — Draft outline/i });
      fireEvent.click(rung);
      expect((screen.getByLabelText("Proposed end") as HTMLInputElement).value).toBe("2026-08-18T21:00");
    } finally {
      state.settings.timezone = planningTimezone;
    }
  });

  it("'I stopped around' ends the session with the chosen time, then answers the trail's tail", async () => {
    state.activeSession = unverifiedDeliverableSession(3);
    const { container } = render(<NowPage />);
    await vi.waitFor(() => expect(container.querySelector(".reconciliation-ladder")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "I stopped around this time" }));
    fireEvent.click(screen.getByRole("button", { name: "The thing" }));
    await vi.waitFor(() =>
      expect(context.runActivityCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: "finish_activity", sessionId: "session-unverified", outcome: "stopped" })
      )
    );
    const activityCalls = (context.runActivityCommand as ReturnType<typeof vi.fn>).mock.calls;
    const activityCall = activityCalls[activityCalls.length - 1]![0];
    expect(typeof activityCall.endedAt).toBe("string");
    await vi.waitFor(() => {
      const checkInCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => String(call[0]) === "/api/commands/check-in"
      );
      expect(checkInCall).toBeTruthy();
    });
  });
});

/**
 * The needs list: what has aged out, asked on Now. The seed state never
 * dated its energy, which reads as stale, so it is the "Also check" case with no help; the rest arm one fact
 * at a time against a state whose energy was said an hour ago.
 */
describe("Now page needs", () => {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const home = {
    id: "ctx-home",
    kind: "location",
    name: "Home",
    status: "active",
    portability: "fixed",
    pathways: []
  } as unknown as (typeof state.conditionDefinitions)[number];
  const dated = () => ({ ...state.currentSituation, energySetAt: hoursAgo(1) });
  const forgotten = (overrides: Partial<ActiveSession>): ActiveSession => ({
    ...runningActionSession,
    id: "session-forgotten",
    startedAt: hoursAgo(19),
    plannedEndAt: hoursAgo(18),
    plannedMinutes: 45,
    ...overrides
  });
  beforeEach(() => {
    matches = false;
    // The writes are shared across the file; a call from another test must not satisfy these.
    vi.clearAllMocks();
  });

  it("asks an undated energy under Also check, in the aside, with the choices", () => {
    const { container } = render(<NowPage />);
    const group = screen.getByRole("region", { name: "Also check" });
    expect(container.querySelector("aside")!.contains(group)).toBe(true);
    expect(screen.queryByRole("region", { name: "Needs an answer first" })).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "Low focus" }));
    expect(context.saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "current_availability",
        entity: expect.objectContaining({ currentEnergy: "low", energyAsserted: true })
      })
    );
  });

  it("says nothing when every fact is current", () => {
    context.state = { ...state, currentSituation: dated() } as typeof state;
    render(<NowPage />);
    expect(screen.queryByRole("region", { name: "Also check" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Needs an answer first" })).toBeNull();
  });

  it("asks a place that aged out once, as a need, and not again under the chips", () => {
    context.state = {
      ...state,
      conditionDefinitions: [home],
      currentSituation: { ...dated(), locationId: "ctx-home", locationSetAt: hoursAgo(30) }
    } as typeof state;
    render(<NowPage />);
    const group = screen.getByRole("region", { name: "Also check" });
    expect(within(group).getByText("Still at Home?")).toBeTruthy();
    // The chip still says it is unsure, but only the need carries the tap.
    expect(screen.getByText("Home?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /still at home/i })).toHaveLength(1);
    fireEvent.click(within(group).getByRole("button", { name: "Still at Home" }));
    expect(context.saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entity: expect.objectContaining({ currentSituation: { locationId: "ctx-home" } }) })
    );
  });

  it("puts a session left open above its panel, and finishes it at the time asked", () => {
    context.state = {
      ...state,
      currentSituation: dated(),
      activeSession: forgotten({ targetType: "routine_step", targetId: "step-1", plannedEndAt: hoursAgo(8) })
    } as typeof state;
    const { container } = render(<NowPage />);
    const stack = screen.getByRole("region", { name: "Needs an answer first" });
    expect(container.querySelector("aside")!.contains(stack)).toBe(false);
    expect(
      stack.compareDocumentPosition(container.querySelector(".action-bar")!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(within(stack).getByRole("button", { name: "It stopped then" }));
    expect(context.runActivityCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "finish_activity",
        sessionId: "session-forgotten",
        outcome: "completed",
        endedAt: hoursAgo(8)
      })
    );
  });

  it("does not repeat a stale session's end under the checkpoint, which asks 'It ended at' itself", () => {
    context.state = {
      ...state,
      currentSituation: dated(),
      activeSession: forgotten({ status: "feedback" })
    } as typeof state;
    render(<NowPage />);
    expect(screen.getByRole("button", { name: "How did it go?" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs an answer first" })).toBeNull();
    expect(screen.queryByRole("button", { name: "It stopped then" })).toBeNull();
  });

  it("asks a stale wake with the preferred time and a field", () => {
    context.state = {
      ...state,
      currentSituation: dated(),
      settings: { ...state.settings, lastWokeAt: hoursAgo(21 * 24) }
    } as typeof state;
    render(<NowPage />);
    const group = screen.getByRole("region", { name: "Also check" });
    fireEvent.click(within(group).getByRole("button", { name: "Woke at 6:00 am" }));
    expect(context.saveEntityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "settings", entity: { lastWokeAt: "2026-08-17T20:00:00.000Z" } })
    );
  });
});
