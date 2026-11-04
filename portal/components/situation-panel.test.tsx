// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { SituationPanel } from "./situation-panel";

const now = new Date("2026-08-18T10:00:00.000Z");

function state(overrides: Partial<PortalState["currentSituation"]> = {}): PortalState {
  const seed = createSeedState(now);
  return { ...seed, currentSituation: { ...seed.currentSituation, ...overrides } };
}

afterEach(() => vi.unstubAllGlobals());

describe("SituationPanel", () => {
  it("edits the transport modes without a bulk refresh button (Manual Measure replaces it)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ spent: 0, remaining: 100, limit: 100 }) })
    );
    const save = vi.fn();
    render(<SituationPanel state={state({ transportModes: ["car"] })} saving={false} now={now} save={save} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Bike" }));
    expect(save).toHaveBeenCalledWith({ transportModes: ["car", "bike"] });
    expect(screen.queryByRole("button", { name: /Measure travel/ })).toBeNull();
  });

  it("keeps the last travel mode ticked and points at Travel off instead", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const save = vi.fn();
    render(<SituationPanel state={state({ transportModes: ["car"] })} saving={false} now={now} save={save} />);
    const car = screen.getByRole("checkbox", { name: "Car" });
    expect((car as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Bike" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/use Travel off/)).toBeTruthy();
  });

  it("saves the Travel off switch, on and off", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const save = vi.fn();
    render(<SituationPanel state={state({ travelOff: false })} saving={false} now={now} save={save} />);
    const travelOff = screen.getByRole("switch", { name: "Travel off" });
    expect(travelOff.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(travelOff);
    expect(save).toHaveBeenLastCalledWith({ travelOff: true });
  });

  it("shows the switch already on, and its own words for what it does", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const save = vi.fn();
    render(<SituationPanel state={state({ travelOff: true })} saving={false} now={now} save={save} />);
    const travelOff = screen.getByRole("switch", { name: "Travel off" });
    expect(travelOff.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(travelOff);
    expect(save).toHaveBeenLastCalledWith({ travelOff: false });
    expect(screen.getByText(/No trip is offered anywhere/)).toBeTruthy();
  });

  it("reads and shows the day's remaining lookups", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ spent: 12, remaining: 88, limit: 100 }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<SituationPanel state={state()} saving={false} now={now} save={vi.fn()} />);
    expect(fetchMock).toHaveBeenCalledWith("/api/travel/budget");
    expect(await screen.findByText("88 of 100 travel-time lookups left today.")).toBeTruthy();
  });

  it("says nothing about the budget when the read fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) }));
    render(<SituationPanel state={state()} saving={false} now={now} save={vi.fn()} />);
    await vi.waitFor(() => expect(screen.queryByText(/lookups left today/)).toBeNull());
  });
});
