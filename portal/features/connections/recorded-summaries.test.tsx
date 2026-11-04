// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import {
  connectionsAnswer,
  deriveRecordedSummaries,
  useRecordedConnectionSummaries,
  type RecordedConnectionInputs
} from "./connection-summaries";
import { registerConnectionExtension, type ConnectionExtension } from "./connection-extensions";

// The seam is stubbed empty so only the two example extensions registered below are present.
vi.mock("@/state/private/index", () => ({}));
const seed = createSeedState(new Date("2026-11-03T22:00:00.000Z"));
vi.mock("@/state/portal-provider", () => ({ usePortal: () => ({ state: seed, ready: true }) }));

const example = (id: string, title: string, after: string): ConnectionExtension => ({
  id,
  title,
  after,
  useRead: () => null,
  summary: () => ({ id, title, state: "on", meta: "" }),
  recorded: { url: `/api/connections/${id}/sync`, synced: "Synced" },
  Detail: () => null
});
registerConnectionExtension(example("alpha", "Alpha", "google-calendar"));
registerConnectionExtension(example("beta", "Beta", "alpha"));

const now = new Date("2026-11-03T22:00:00.000Z"); // 9:00 am on the 4th in the seed zone
const run = (status: string, at = "2026-11-03T21:30:00.000Z") => ({ startedAt: at, finishedAt: at, status });
const base: RecordedConnectionInputs = {
  ready: true,
  timezone: "Australia/Sydney",
  planning: undefined,
  googleCalendar: { enabled: true, lastRun: run("synced") },
  extensions: { alpha: { enabled: true, lastRun: run("synced") }, beta: { lastRun: run("synced") } }
};

afterEach(() => vi.unstubAllGlobals());

describe("deriveRecordedSummaries", () => {
  it("reads each connection from its last recorded run", () => {
    const rows = deriveRecordedSummaries(
      {
        ...base,
        extensions: { alpha: { enabled: false, lastRun: null }, beta: { lastRun: run("failed") } }
      },
      now
    );
    expect(rows.map((row) => [row.id, row.state, row.meta])).toEqual([
      ["planner", "unknown", "No plan calculated yet"],
      ["google-calendar", "on", "Synced 8:30 am"],
      ["alpha", "setup", "Not connected (optional)"],
      ["beta", "off", "The last run failed, 8:30 am"]
    ]);
  });

  it("never claims everything is connected when some connection has nothing recorded", () => {
    const rows = deriveRecordedSummaries({ ...base, extensions: { ...base.extensions, beta: { lastRun: null } } }, now);
    expect(connectionsAnswer(rows)).toBe("No connection has reported a problem.");
  });
});

function Probe() {
  const rows = useRecordedConnectionSummaries();
  return <p>{rows.map((row) => `${row.id}:${row.state}`).join(" ")}</p>;
}

describe("useRecordedConnectionSummaries", () => {
  it("only reads recorded runs: no proof, probe or provider status call", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ enabled: true, lastRun: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await waitFor(() => expect(screen.getByText(/beta:unknown/)).toBeTruthy());
    const urls = fetchMock.mock.calls.map(([url]) => url).sort();
    expect(urls).toEqual([
      "/api/connections/alpha/sync",
      "/api/connections/beta/sync",
      "/api/connections/google_calendar/sync"
    ]);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit | undefined][])
      expect(init?.method ?? "GET").toBe("GET");
  });
});
