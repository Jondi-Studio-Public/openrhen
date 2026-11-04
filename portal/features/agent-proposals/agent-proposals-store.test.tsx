// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProposal } from "@openrhen/contracts";
import { act, render, screen } from "@/test/render";
import {
  ageLabel,
  dismissHeldAgentProposal,
  handledAgentRows,
  pendingAgentProposals,
  refreshAgentProposals,
  resetAgentProposals,
  resolveAgentProposalRequest,
  shownAgentProposals,
  useAgentProposals
} from "./agent-proposals-store";

const row = (overrides: Partial<AgentProposal>): AgentProposal => ({
  id: "i",
  agent: "scribe",
  kind: "entity_command",
  summary: "S",
  payload: {},
  basis: "inferred",
  evidence: null,
  targetVersions: {},
  status: "pending",
  coalesceKey: null,
  revision: 1,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...overrides
});

const respond = (status: number, body: unknown) =>
  vi.fn(() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) }));

function Probe() {
  return <p>{`pending ${pendingAgentProposals(useAgentProposals()).length}`}</p>;
}

beforeEach(() => resetAgentProposals());
afterEach(() => vi.unstubAllGlobals());

describe("agent proposal store", () => {
  it("counts pending proposals for the Inbox badge and keeps the last list when a read fails", async () => {
    vi.stubGlobal("fetch", respond(200, { proposals: [row({ id: "a" }), row({ id: "b", status: "rejected" })] }));
    render(<Probe />);
    await refreshAgentProposals();
    expect(await screen.findByText("pending 1")).toBeTruthy();
    vi.stubGlobal("fetch", respond(500, { error: "down" }));
    await refreshAgentProposals();
    expect(screen.getByText("pending 1")).toBeTruthy();
  });

  it("lists recently handled proposals from the last seven days only, with the agent and the note", () => {
    const now = new Date("2026-10-18T12:00:00.000Z").getTime();
    const rows = handledAgentRows(
      [
        row({ id: "a", status: "confirmed", resolvedAt: "2026-10-17T00:00:00.000Z", resolutionNote: "ok" }),
        row({ id: "b", status: "rejected", resolvedAt: "2026-10-01T00:00:00.000Z" }),
        row({ id: "c", status: "pending" })
      ],
      now
    );
    expect(rows).toEqual([
      { id: "a", title: "S", detail: "from scribe · ok", outcome: "confirmed", at: "2026-10-17T00:00:00.000Z" }
    ]);
  });

  it("returns the stale diff from a 409 and refreshes the list", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes("/resolve")
          ? {
              ok: false,
              status: 409,
              json: () =>
                Promise.resolve({
                  error: "Changed",
                  stale: true,
                  conflicts: [{ entity: "project:p", proposedAgainst: 1, current: 2 }]
                })
            }
          : { ok: true, status: 200, json: () => Promise.resolve({ proposals: [] }) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await resolveAgentProposalRequest("id", "confirm", 1);
    expect(outcome).toMatchObject({ ok: false, stale: true, conflicts: [{ entity: "project:p", current: 2 }] });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/agent-proposals?"))).toBe(true);
  });

  it("keeps showing a proposal the person found stale until they dismiss it, without counting it", async () => {
    const settled = row({ id: "s", status: "stale" });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes("/resolve")
          ? { ok: false, status: 409, json: () => Promise.resolve({ error: "Changed", stale: true, conflicts: [] }) }
          : { ok: true, status: 200, json: () => Promise.resolve({ proposals: [row({ id: "a" }), settled] }) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await refreshAgentProposals();
    function Shown() {
      const proposals = useAgentProposals();
      return (
        <p>{`shown ${shownAgentProposals(proposals).map((item) => item.id)} pending ${pendingAgentProposals(proposals).length}`}</p>
      );
    }
    render(<Shown />);
    // A stale proposal nobody just tried to confirm (an older one) is not shown.
    expect(await screen.findByText("shown a pending 1")).toBeTruthy();
    await resolveAgentProposalRequest("s", "confirm", 1);
    // Shown until dismissed, but never counted as waiting.
    expect(await screen.findByText("shown a,s pending 1")).toBeTruthy();
    act(() => dismissHeldAgentProposal("s"));
    expect(await screen.findByText("shown a pending 1")).toBeTruthy();
  });

  it("sends the revision, and on a changed answer refreshes without holding the proposal", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes("/resolve")
          ? { ok: false, status: 409, json: () => Promise.resolve({ error: "x", changed: true, proposal: {} }) }
          : { ok: true, status: 200, json: () => Promise.resolve({ proposals: [] }) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await resolveAgentProposalRequest("c", "confirm", 3);
    expect(outcome).toEqual({
      ok: false,
      stale: false,
      changed: true,
      message: "The agent changed this after you opened it. Read it again before confirming.",
      conflicts: []
    });
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/resolve")) as unknown as [
      string,
      RequestInit
    ];
    expect(JSON.parse(String(post[1].body))).toEqual({ decision: "confirm", revision: 3 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/agent-proposals?"))).toBe(true);
  });

  it("reports an unreachable portal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    expect(await resolveAgentProposalRequest("id", "reject", 1)).toMatchObject({ ok: false, stale: false });
  });
});

describe("ageLabel", () => {
  it("reads in minutes, hours and days", () => {
    const now = new Date("2026-10-18T12:00:00.000Z").getTime();
    expect(ageLabel("2026-10-18T11:59:50.000Z", now)).toBe("just now");
    expect(ageLabel("2026-10-18T11:30:00.000Z", now)).toBe("30 min ago");
    expect(ageLabel("2026-10-18T06:00:00.000Z", now)).toBe("6 h ago");
    expect(ageLabel("2026-10-14T12:00:00.000Z", now)).toBe("4 d ago");
  });
});
