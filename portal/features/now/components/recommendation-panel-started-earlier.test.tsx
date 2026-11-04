// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { NowCandidate } from "@/features/now/now-model";
import { dateInput, iso } from "@/features/today/local-datetime";
import { RecommendationPanel } from "./recommendation-panel";

const tz = "Australia/Sydney";
const localAt = (offsetMinutes: number) => dateInput(new Date(Date.now() + offsetMinutes * 60_000).toISOString(), tz);

const now = new Date("2026-08-18T10:00:00.000Z");
const state = createSeedState(now);
const primary: NowCandidate = {
  action: state.actions[0]!,
  eligible: true,
  exclusionReasons: [],
  recommendedMinutes: 45,
  totalScore: 12,
  scoreComponents: { deadlinePressure: 5 }
};

function renderPanel(
  onStartCurrent = vi.fn(),
  extra: {
    openElse?: boolean;
    onElseOpened?: () => void;
    saving?: boolean;
    planningDecisionCurrent?: boolean;
    startFloor?: Date | null;
    planPending?: boolean;
  } = {}
) {
  render(
    <RecommendationPanel
      primary={primary}
      saving={false}
      planningDecisionCurrent
      timezone="Australia/Sydney"
      explanation="Most pressing."
      evidence={[]}
      plannedEnd={new Date(now.getTime() + 45 * 60_000)}
      nextCommitment={undefined}
      forecast={undefined}
      alternatives={[]}
      deliverableDirective={null}
      directedDeliverable={undefined}
      overrideReason="better_fit"
      onOverrideReasonChange={vi.fn()}
      onStartCurrent={onStartCurrent}
      startAlternative={vi.fn().mockResolvedValue(undefined)}
      blockRecommended={vi.fn().mockResolvedValue(undefined)}
      runActivityCommand={vi.fn().mockResolvedValue(undefined)}
      {...extra}
    />
  );
  return onStartCurrent;
}

describe("RecommendationPanel Started earlier?", () => {
  it("starts now, with no start time, when nothing is chosen", () => {
    const onStartCurrent = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStartCurrent).toHaveBeenCalledWith(undefined);
  });

  it("sends the start time a chip names", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      const onStartCurrent = renderPanel();
      fireEvent.click(screen.getByRole("button", { name: "30 min ago" }));
      fireEvent.click(screen.getByRole("button", { name: /^Start from / }));
      expect(onStartCurrent).toHaveBeenCalledWith(new Date(now.getTime() - 30 * 60_000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the time that was picked", () => {
    const onStartCurrent = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
    const picked = localAt(-15);
    fireEvent.change(screen.getByLabelText("It started at"), { target: { value: picked } });
    fireEvent.click(screen.getByRole("button", { name: /^Start from / }));
    expect(onStartCurrent).toHaveBeenCalledWith(iso(picked, tz));
  });
});

describe("RecommendationPanel after Switch to", () => {
  it("opens Something else once, and says so, when the last session ended to switch", () => {
    const onElseOpened = vi.fn();
    renderPanel(vi.fn(), { openElse: true, onElseOpened });
    expect(screen.getByRole("dialog", { name: "Something else" })).toBeTruthy();
    expect(onElseOpened).toHaveBeenCalledTimes(1);
  });

  it("leaves Something else shut otherwise", () => {
    renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("RecommendationPanel start clamps", () => {
  it("reads Start from the chosen time once a chip is pressed", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "10 min ago" }));
    expect(screen.getByRole("button", { name: /^Start from \d{1,2}:\d{2} [ap]m$/i })).toBeTruthy();
  });

  it("disables a chip below the floor", () => {
    renderPanel(vi.fn(), { startFloor: new Date(Date.now() - 20 * 60_000) });
    expect((screen.getByRole("button", { name: "30 min ago" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "10 min ago" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the earliest start when a chip is disabled, and stays quiet otherwise", () => {
    renderPanel(vi.fn(), { startFloor: new Date(Date.now() - 20 * 60_000) });
    expect(screen.getByText(/^Earliest: \d{1,2}:\d{2} [ap]m \(you woke or your last session ended\)$/i)).toBeTruthy();
  });

  it("shows no earliest line when no chip is disabled", () => {
    renderPanel(vi.fn(), { startFloor: new Date(Date.now() - 5 * 60 * 60_000) });
    expect(screen.queryByText(/^Earliest:/)).toBeNull();
  });

  it("refuses to Start from a typed time still ahead", () => {
    const onStartCurrent = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
    const local = localAt(60);
    fireEvent.change(screen.getByLabelText("It started at"), { target: { value: local } });
    expect(screen.getByRole("alert").textContent).toBe("That time is still ahead.");
    expect((screen.getByRole("button", { name: /^Start/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(onStartCurrent).not.toHaveBeenCalled();
  });
});

describe("Something else after Switch to, while the plan catches up", () => {
  it("says it is working out what fits, not that nothing does, while the plan is not current", () => {
    renderPanel(vi.fn(), { openElse: true, planningDecisionCurrent: false });
    expect(screen.getByText("Working out what fits…")).toBeTruthy();
    expect(screen.queryByText(/Nothing else on the list fits/)).toBeNull();
  });

  it("says the same while a command is saving", () => {
    renderPanel(vi.fn(), { openElse: true, saving: true });
    expect(screen.getByText("Working out what fits…")).toBeTruthy();
  });

  it("says nothing fits once the plan is current and the list is empty", () => {
    renderPanel(vi.fn(), { openElse: true });
    expect(screen.getByText("Nothing else on the list fits right now.")).toBeTruthy();
  });
});

describe("Something else right after Switch to", () => {
  it("keeps saying it is working out what fits while the plan after the stop has not landed", () => {
    // The plan on screen reads as current (it is the one from before the stop), and the list is empty.
    renderPanel(vi.fn(), { openElse: true, planPending: true });
    expect(screen.getByText("Working out what fits…")).toBeTruthy();
    expect(screen.queryByText(/Nothing else on the list fits/)).toBeNull();
  });

  it("opens with focus on the dialog itself, not on the last control in the list", () => {
    renderPanel(vi.fn(), { openElse: true, planPending: true });
    const dialog = screen.getByRole("dialog", { name: "Something else" });
    expect(document.activeElement).toBe(dialog);
  });

  it("returns focus to Start when it closes, since the Switch to button that opened it is gone", () => {
    renderPanel(vi.fn(), { openElse: true, planPending: true });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Something else" }), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start" }));
  });

  it("leaves focus to the usual opener when Something else is opened by hand", () => {
    renderPanel();
    const opener = screen.getByRole("button", { name: "Something else…" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(screen.getByRole("dialog", { name: "Something else" }));
  });
});

describe("Started earlier? when the primary changes", () => {
  it("drops the chosen time when a replan puts another task first", () => {
    const onStartCurrent = vi.fn();
    const props = {
      timezone: "Australia/Sydney",
      saving: false,
      planningDecisionCurrent: true,
      explanation: "Most pressing.",
      evidence: [] as string[],
      plannedEnd: new Date(now.getTime() + 45 * 60_000),
      nextCommitment: undefined,
      forecast: undefined,
      alternatives: [] as NowCandidate[],
      deliverableDirective: null,
      directedDeliverable: undefined,
      overrideReason: "better_fit" as const,
      onOverrideReasonChange: vi.fn(),
      onStartCurrent,
      startAlternative: vi.fn().mockResolvedValue(undefined),
      blockRecommended: vi.fn().mockResolvedValue(undefined),
      runActivityCommand: vi.fn().mockResolvedValue(undefined)
    };
    const other: NowCandidate = { ...primary, action: state.actions[1]! };
    const { rerender } = render(<RecommendationPanel {...props} primary={primary} />);
    fireEvent.click(screen.getByRole("button", { name: "30 min ago" }));
    expect(screen.getByRole("button", { name: /^Start from / })).toBeTruthy();
    rerender(<RecommendationPanel {...props} primary={other} />);
    expect(screen.getByRole("button", { name: "30 min ago" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStartCurrent).toHaveBeenCalledWith(undefined);
  });
});
