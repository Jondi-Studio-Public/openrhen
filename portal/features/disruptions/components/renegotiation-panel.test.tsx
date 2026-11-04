// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type StoredCommitment } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { RenegotiationPanel } from "./renegotiation-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const timezone = "Australia/Sydney";
const state = createSeedState(now);

// `LetSomeoneKnow` reads state through `usePortal()`, not through this panel's own `state` prop, so
// every test needs the mock even though most never render the button at all.
let context: Record<string, unknown> = { state };
vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => context };
});

const disruption: StoredCommitment = {
  id: "disruption-1",
  title: "Drive Mum to the shops",
  startsAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
  endsAt: new Date(now.getTime() + 40 * 60_000).toISOString(),
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  origin: "disruption",
  disruptionSource: "family",
  landedAt: new Date(now.getTime() - 20 * 60_000).toISOString()
};

function stubFetch(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => Promise.resolve(payload) }));
}

const baseProps = {
  disruption,
  state,
  now,
  timezone,
  saving: false,
  saveEntityCommand: vi.fn().mockResolvedValue(undefined)
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("RenegotiationPanel", () => {
  it("renders the consequences of a renegotiate-tier response", async () => {
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 35,
      // After the disruption's landedAt (09:40), so the shift is attributed to it.
      beforeNightPlannedStartAt: "2026-08-18T20:00:00.000Z",
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    });
    render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() =>
      expect(screen.getByText(/This displaces: Draft networking assignment section 1/)).toBeTruthy()
    );
    expect(screen.getByText("Bedtime moves 35 min later.")).toBeTruthy();
    expect(screen.getByText("Shorten the disruption")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
  });

  it("renders nothing for an absorbed response", async () => {
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 5,
      newlyDisplaced: []
    });
    const { container } = render(<RenegotiationPanel {...baseProps} />);
    // Give the fetch a turn to resolve before asserting the panel stayed empty.
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("hides itself once dismissed, without writing anything to the server", async () => {
    const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    });
    const { container } = render(<RenegotiationPanel {...baseProps} saveEntityCommand={saveEntityCommand} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    expect(container.innerHTML).toBe("");
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  // Dismissal used to live only in useState, so a remount — a navigation, a reload,
  // Now's own periodic refresh — brought the exact same "This changes today" prompt straight back for
  // as long as the disruption's displaced set stayed the same. It has to survive a fresh mount now.
  it("stays dismissed across a remount when the displaced set has not changed", async () => {
    const payload = {
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    };
    stubFetch(payload);
    const first = render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    first.unmount();

    stubFetch(payload);
    const second = render(<RenegotiationPanel {...baseProps} />);
    // Give the fetch a turn to resolve before asserting the panel stayed hidden.
    await vi.waitFor(() => expect(second.container.innerHTML).toBe(""));
  });

  // A target that never held a slot in the plan at all (firstPlannedAt null) is
  // ordinary capacity/priority pressure, not something this disruption moved. Left in, it flickers
  // in and out of `newlyDisplaced` for hours after landing with no user action in between, repeatedly
  // re-arming "This changes today".
  it("renders nothing when the only newly displaced target never held a slot at all", async () => {
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: null }]
    });
    const { container } = render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
  });

  // The audit found: the panel used to fetch only on `disruption.id` change, so a
  // disruption's downstream impact turning renegotiate-tier a few seconds after this panel's first
  // mount went unnoticed until something else remounted it. `refreshKey` ties the fetch to the same
  // plan-refresh signal every other Now-page banner reacts to.
  it("re-fetches when refreshKey changes, even though disruption.id has not", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          available: true,
          moved: [],
          dropped: [],
          added: [],
          sleepShiftMinutes: 0,
          newlyDisplaced: []
        })
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<RenegotiationPanel {...baseProps} refreshKey={1} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<RenegotiationPanel {...baseProps} refreshKey={2} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // The other half of the same finding: a `refreshKey`-driven re-fetch must not resurrect a prompt
  // already dismissed for the exact verdict on screen, even though it now happens without a remount
  // (the only way the pre-`refreshKey` code could ever see a second fetch at all).
  it("does not resurrect a dismissal when refreshKey changes but the displaced set does not", async () => {
    const payload = {
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    };
    stubFetch(payload);
    const { container, rerender } = render(<RenegotiationPanel {...baseProps} refreshKey={1} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    expect(container.innerHTML).toBe("");

    stubFetch(payload);
    rerender(<RenegotiationPanel {...baseProps} refreshKey={2} />);
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("re-arms once the displaced set changes, even after a dismissal", async () => {
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    });
    const first = render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    fireEvent.click(screen.getByText("Not now"));
    first.unmount();

    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [
        { targetId: "networking-section-one", firstPlannedAt: "2026-08-18T09:00:00.000Z" },
        { targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }
      ]
    });
    render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
  });

  it("offers Let ... know? for a displaced commitment whose contact resolves, and opens the sheet on it", async () => {
    const withContact = {
      ...state,
      commitments: state.commitments.map((item) => (item.id === "dinner" ? { ...item, contactId: "sam" } : item)),
      conditionDefinitions: [
        ...state.conditionDefinitions,
        { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }
      ]
    } as unknown as typeof state;
    context = { state: withContact };
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    });
    render(<RenegotiationPanel {...baseProps} state={withContact} />);
    expect(await screen.findByRole("button", { name: "Let Sam know?" })).toBeTruthy();
  });

  it("offers nothing for a displaced commitment with no contact", async () => {
    stubFetch({
      available: true,
      moved: [],
      dropped: [],
      added: [],
      sleepShiftMinutes: 0,
      newlyDisplaced: [{ targetId: "dinner", firstPlannedAt: "2026-08-18T09:00:00.000Z" }]
    });
    context = { state };
    render(<RenegotiationPanel {...baseProps} />);
    await vi.waitFor(() => expect(screen.getByText("Not now")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Let .* know\?/ })).toBeNull();
  });
});
