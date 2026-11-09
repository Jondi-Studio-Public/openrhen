import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { CliError } from "../errors.js";
import { driftCommand } from "./drift.js";

const body = {
  generatedAt: "2026-01-05T12:00:00.000Z",
  window: { from: "2025-12-06T12:00:00.000Z", to: "2026-01-05T12:00:00.000Z" },
  legacyBefore: null,
  truncated: true,
  counts: {
    episodes: 1,
    pinned: 1,
    byType: { deviated_checkin: { episodes: 0, pinned: 0 }, unsanctioned_session: { episodes: 1, pinned: 1 } },
    bySignal: { checkin_deviated: 0, session_started: 1, session_ended: 1 }
  },
  episodes: [
    {
      id: "unsanctioned_session:s1",
      type: "unsanctioned_session",
      occurredAt: "2026-01-05T09:00:00.000Z",
      knownAt: "2026-01-05T09:00:00.000Z",
      pinned: true,
      evidence: [{}, {}]
    }
  ]
};

function run(values: Record<string, unknown>, positionals = ["report"], get = vi.fn().mockResolvedValue(body)) {
  const out: string[] = [];
  const client = { baseUrl: "http://localhost:8787", getState: vi.fn(), get, post: vi.fn() } as unknown as PortalClient;
  const context: CommandContext = {
    client,
    mode: values.json ? "json" : "table",
    now: () => new Date("2026-01-05T12:00:00Z"),
    stdout: (text) => out.push(text),
    stderr: () => {},
    setExitCode: () => {}
  };
  return driftCommand.run(context, { positionals, values } as never).then(() => ({ text: out.join("\n"), get }));
}

describe("rhen drift report", () => {
  it("is read-only and owner only, so it adds no MCP tool", () => {
    expect(driftCommand.mutates).toBe(false);
    expect(driftCommand.ownerOnly).toBe(true);
  });

  it("calls the portal route and summarises episodes, signals and the row limit", async () => {
    const { text, get } = await run({});
    expect(get).toHaveBeenCalledWith("/api/drift-report");
    expect(text).toContain("1 (1 pinned)");
    expect(text).toContain("unsanctioned_session: 1 (1 pinned)");
    expect(text).toContain("session_ended 1");
    expect(text).toContain("--legacy-before");
    expect(text).toContain("row limit");
  });

  it("passes the window and the legacy cut as query parameters", async () => {
    const { get } = await run({
      days: "14",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-10T00:00:00Z",
      "legacy-before": "2025-12-01T00:00:00Z"
    });
    expect(get).toHaveBeenCalledWith(
      "/api/drift-report?days=14&from=2026-01-01T00%3A00%3A00Z&to=2026-01-10T00%3A00%3A00Z&legacyBefore=2025-12-01T00%3A00%3A00Z"
    );
  });

  it("prints the body as JSON with --json", async () => {
    const { text } = await run({ json: true });
    expect(JSON.parse(text)).toEqual(body);
  });

  it("refuses an unknown action, a bad time, a state file and an odd body", async () => {
    await expect(run({}, ["status"])).rejects.toBeInstanceOf(CliError);
    await expect(run({ from: "yesterday" })).rejects.toBeInstanceOf(CliError);
    await expect(run({ "state-file": "x.json" })).rejects.toBeInstanceOf(CliError);
    await expect(run({}, ["report"], vi.fn().mockResolvedValue({ nope: true }))).rejects.toBeInstanceOf(CliError);
  });
});
