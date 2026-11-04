// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { AgentTimeLine } from "./agent-time-line";

const summary = {
  windowStart: "2026-10-19T00:00:00.000Z",
  windowEnd: "2026-10-26T00:00:00.000Z",
  totalMinutes: 250,
  agents: [
    { agent: "openclaw", minutes: 185, sessions: 4 },
    { agent: "claude-code", minutes: 90, sessions: 2 }
  ],
  topics: [{ topic: "OpenRhen build", minutes: 200 }]
};

afterEach(() => vi.unstubAllGlobals());

describe("AgentTimeLine", () => {
  it("shows one line with the total, the busiest agent and the top topic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(summary)))
    );
    render(<AgentTimeLine />);
    expect(
      await screen.findByText("Agent time, last 7 days: 4h 10m, mostly openclaw (3h 5m); top topic: OpenRhen build.")
    ).toBeTruthy();
  });

  it("says so when nothing was recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ ...summary, totalMinutes: 0, agents: [], topics: [] })))
    );
    render(<AgentTimeLine />);
    expect(await screen.findByText("Agent time, last 7 days: none recorded.")).toBeTruthy();
  });

  it("shows nothing when the read fails", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 503 })));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AgentTimeLine />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
