// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import { ClosedByAgentLine } from "./closed-by-agent-line";

const context = { state: {} };
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

function answer(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }))
  );
}

describe("ClosedByAgentLine", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says how many an agent closed and links to the cancelled tab", async () => {
    answer({ agentLast24h: 2, latestAt: "2026-11-04T01:00:00.000Z" });
    render(<ClosedByAgentLine />);
    expect(await screen.findByText("2 items closed by an agent in the last 24 hours.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/review/closed?tab=cancelled");
  });

  it("uses the singular for one", async () => {
    answer({ agentLast24h: 1, latestAt: "2026-11-04T01:00:00.000Z" });
    render(<ClosedByAgentLine />);
    expect(await screen.findByText("1 item closed by an agent in the last 24 hours.")).toBeTruthy();
  });

  it("shows nothing at zero or when the read fails", async () => {
    answer({ agentLast24h: 0, latestAt: null });
    const first = render(<ClosedByAgentLine />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(first.container.textContent).toBe("");
    first.unmount();
    answer({ error: "no" }, false);
    const second = render(<ClosedByAgentLine />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(second.container.textContent).toBe("");
  });

  it("is cleared once this device has looked since the latest agent close", async () => {
    window.localStorage.setItem("openrhen.closed.lookedAt", "2026-11-04T02:00:00.000Z");
    answer({ agentLast24h: 3, latestAt: "2026-11-04T01:00:00.000Z" });
    const view = render(<ClosedByAgentLine />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(view.container.textContent).toBe("");
  });

  it("shows again for a close after the last look", async () => {
    window.localStorage.setItem("openrhen.closed.lookedAt", "2026-11-04T00:00:00.000Z");
    answer({ agentLast24h: 1, latestAt: "2026-11-04T01:00:00.000Z" });
    render(<ClosedByAgentLine />);
    expect(await screen.findByText(/closed by an agent/)).toBeTruthy();
  });
});
