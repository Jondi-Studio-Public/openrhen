// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { rememberDisruption } from "../disruption-undo";
import { DisruptionLine } from "./disruption-line";
import { DisruptionSheet } from "./disruption-sheet";

const now = new Date("2026-10-29T03:00:00.000Z");
freezeClock(now);
const acceptServerState = vi.fn();
let pulse: PortalState["pulse"];

vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return {
    ...actual,
    usePortal: () => {
      const state = createSeedState(now);
      return {
        state: {
          ...state,
          pulse,
          conditionDefinitions: [
            { id: "home", name: "Home", kind: "location", status: "active" },
            { id: "cap-phone", name: "Phone", kind: "capability", status: "active" }
          ]
        },
        acceptServerState
      };
    }
  };
});

beforeEach(() => {
  vi.unstubAllGlobals();
  acceptServerState.mockReset();
  rememberDisruption(null);
  pulse = undefined;
});

describe("DisruptionSheet", () => {
  it("refuses an empty form client-side, naming the fields, without posting", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DisruptionSheet open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/what you are doing, until when, where you are/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a complete form, hands over the state and closes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      json: async () => ({ state: { marker: "disrupted" }, revertible: "cmd-3", result: { ended: false } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<DisruptionSheet open onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("What are you doing?"), { target: { value: "Picking up the kids" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "No, I could do other things" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/commands/pulse-disruption");
    expect(JSON.parse(init!.body!)).toMatchObject({
      doing: "Picking up the kids",
      locationId: "home",
      contexts: ["cap-phone"],
      exclusive: false
    });
    expect(acceptServerState).toHaveBeenCalledWith({ marker: "disrupted" });
  });

  it("retries the same submit under the same command id, and mints a new one when the form changes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: false,
      json: async () => ({ error: "offline" })
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DisruptionSheet open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("What are you doing?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, all of me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await screen.findByText("offline");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const id = (n: number) => JSON.parse(fetchMock.mock.calls[n]![1]!.body!).commandId as string;
    expect(id(1)).toBe(id(0));
    fireEvent.click(screen.getByRole("button", { name: "2 hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(id(2)).not.toBe(id(0));
  });

  it("shows the server's missing fields on a 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ code: "disruptionIncomplete", error: "no", missing: ["contexts"] })
      }))
    );
    render(<DisruptionSheet open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("What are you doing?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, all of me" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/what you have available/)).toBeTruthy();
  });
});

describe("DisruptionLine", () => {
  const disrupted: NonNullable<PortalState["pulse"]> = {
    state: "on",
    reason: "disrupted",
    shares: {
      today: { onPercent: null, countedMinutes: 0 },
      days7: { onPercent: null, countedMinutes: 0 },
      days30: { onPercent: null, countedMinutes: 0 }
    },
    since: now.toISOString(),
    private: false,
    disruption: {
      doing: "Picking up the kids",
      until: "2026-10-29T04:00:00.000Z",
      locationId: "home",
      contexts: ["cap-phone"],
      exclusive: true,
      recordedBy: "person"
    }
  };

  it("shows what this tab just recorded before the recorder has moved the pulse", () => {
    rememberDisruption({ commandId: "c", doing: "Kids", until: "2099-01-01T00:00:00.000Z" });
    render(<DisruptionLine />);
    expect(screen.getByText(/On plan, disrupted: Kids until/)).toBeTruthy();
  });

  it("does not show a state disruption past its until as in force", () => {
    pulse = { ...disrupted, disruption: { ...disrupted.disruption!, until: "2026-10-29T02:00:00.000Z" } };
    const { container } = render(<DisruptionLine />);
    expect(container.innerHTML).toBe("");
  });

  it("forgets a local record that has run out", () => {
    rememberDisruption({ commandId: "c", doing: "Kids", until: "2026-10-29T02:00:00.000Z" });
    const { container } = render(<DisruptionLine />);
    expect(container.innerHTML).toBe("");
    pulse = undefined;
    rememberDisruption({ commandId: "c", doing: "Kids", until: "2099-01-01T00:00:00.000Z" });
    expect(render(<DisruptionLine />).container.innerHTML).not.toBe("");
  });

  it("drops the local fallback once the state held the disruption and has lost it", () => {
    rememberDisruption({ commandId: "c", doing: "Kids", until: "2099-01-01T00:00:00.000Z" });
    pulse = disrupted;
    const view = render(<DisruptionLine />);
    expect(screen.getByText(/Picking up the kids/)).toBeTruthy();
    pulse = undefined;
    view.rerender(<DisruptionLine />);
    expect(view.container.innerHTML).toBe("");
  });

  it("renders nothing without a disruption", () => {
    const { container } = render(<DisruptionLine />);
    expect(container.innerHTML).toBe("");
  });

  it("says what and until when, and ends it", async () => {
    pulse = disrupted;
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      json: async () => ({ state: { marker: "ended" }, result: { ended: true } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DisruptionLine />);
    expect(screen.getByText(/On plan, disrupted: Picking up the kids until/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "It's over" }));
    await waitFor(() => expect(acceptServerState).toHaveBeenCalledWith({ marker: "ended" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body!)).toMatchObject({ end: true });
  });

  it("offers Undo in the tab that recorded it, through the revert route", async () => {
    pulse = disrupted;
    rememberDisruption({ commandId: "cmd-3", doing: "Picking up the kids", until: "2099-01-01T00:00:00.000Z" });
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      json: async () => ({ state: { marker: "undone" } })
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DisruptionLine />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(acceptServerState).toHaveBeenCalledWith({ marker: "undone" }));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/commands/revert");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body!)).toMatchObject({ target: "cmd-3", direction: "undo" });
  });
});
