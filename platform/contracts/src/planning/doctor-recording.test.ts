import { describe, expect, it } from "vitest";
import { recordingItems, type DoctorRecordingSlice } from "./doctor-recording.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const quiet: DoctorRecordingSlice = {
  backup: { status: "synced", lastRunAt: hoursAgo(5), lastSuccessAt: hoursAgo(5) },
  phonePing: { configured: true, lastPingAt: hoursAgo(2) },
  deadAgentWakes: { count: 0, lastError: null },
  agentTokens: [{ name: "claw", expiresAt: hoursAgo(-24 * 60), lastUsedAt: hoursAgo(1) }],
  agentTime: { lastReportedAt: hoursAgo(5) }
};

describe("recordingItems", () => {
  it("is quiet for a fresh backup and a recent ping", () => {
    expect(recordingItems(quiet, NOW)).toEqual([]);
  });

  it("says no backup has run yet, degrading rather than blocking, in words for the owner", () => {
    const items = recordingItems({ ...quiet, backup: null }, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "backup_never", tier: "degrading", title: "No backup has run yet" });
    const text = JSON.stringify(items[0]);
    expect(text).not.toContain("BACKUP_ENABLED");
    expect(text).toContain("docker compose logs backup");
  });

  it("flags a missed night, and a run that failed since the last success", () => {
    const items = recordingItems(
      { ...quiet, backup: { status: "failed", lastRunAt: hoursAgo(3), lastSuccessAt: hoursAgo(60) } },
      NOW
    );
    expect(items.map((i) => i.id)).toEqual(["backup_stale"]);
    expect(items[0]!.title).toContain("3 days");
  });

  it("flags a warning run as degrading while the backup itself is fresh", () => {
    const items = recordingItems(
      { ...quiet, backup: { status: "needs_review", lastRunAt: hoursAgo(2), lastSuccessAt: hoursAgo(26) } },
      NOW
    );
    expect(items.map((i) => [i.id, i.tier])).toEqual([["backup_warning", "degrading"]]);
  });

  it("says backups don't leave this machine when the latest run was local-only, without calling it a failure", () => {
    const items = recordingItems(
      { ...quiet, backup: { status: "synced", lastRunAt: hoursAgo(5), lastSuccessAt: hoursAgo(5), localOnly: true } },
      NOW
    );
    expect(items.map((i) => [i.id, i.tier, i.title])).toEqual([
      ["backup_local_only", "degrading", "Backups don't leave this machine"]
    ]);
    expect(JSON.stringify(items[0])).toContain("BACKUP_COPY_DIR");
  });

  it("never skips the restore check silently: a skipped one is its own finding, not a second generic warning", () => {
    const items = recordingItems(
      {
        ...quiet,
        backup: { status: "needs_review", lastRunAt: hoursAgo(2), lastSuccessAt: hoursAgo(2), restoreSkipped: true }
      },
      NOW
    );
    expect(items.map((i) => i.id)).toEqual(["backup_unverified"]);
    expect(JSON.stringify(items[0])).toContain("POSTGRES_ADMIN_URL");
  });

  it("flags a silent phone only when the channel is configured and has pinged before", () => {
    const silent = { configured: true, lastPingAt: hoursAgo(72) };
    expect(recordingItems({ ...quiet, phonePing: silent }, NOW).map((i) => i.id)).toEqual(["location_ping_silent"]);
    expect(recordingItems({ ...quiet, phonePing: { ...silent, configured: false } }, NOW)).toEqual([]);
    expect(recordingItems({ ...quiet, phonePing: { configured: true, lastPingAt: null } }, NOW)).toEqual([]);
  });

  it("flags dead agent wakes with the latest error and the next call, and is quiet at zero", () => {
    const dead = { count: 2, lastError: "http 502" };
    const items = recordingItems({ ...quiet, deadAgentWakes: dead }, NOW);
    expect(items.map((i) => [i.id, i.tier])).toEqual([["agent_wake_dead", "degrading"]]);
    expect(items[0]!.title).toBe("2 agent wakes were not delivered in the last 24 h");
    expect(items[0]!.fix.question).toContain("http 502");
    expect(items[0]!.fix.question).toContain("priorities_doctor");
    expect(recordingItems({ ...quiet, deadAgentWakes: { count: 1, lastError: null } }, NOW)[0]!.title).toBe(
      "1 agent wake was not delivered in the last 24 h"
    );
  });

  it("flags an agent token that expires within 7 days or has expired (D-D7, D-D16)", () => {
    const soon = recordingItems(
      { ...quiet, agentTokens: [{ name: "claw", expiresAt: hoursAgo(-24 * 5), lastUsedAt: hoursAgo(2) }] },
      NOW
    );
    expect(soon.map((i) => [i.id, i.tier])).toEqual([["agent_token_expiring:claw", "degrading"]]);
    expect(soon[0]!.title).toBe('The agent token "claw" expires in 5 days');
    expect(soon[0]!.dueAt).toBe(hoursAgo(-24 * 5));
    const gone = recordingItems(
      { ...quiet, agentTokens: [{ name: "claw", expiresAt: hoursAgo(30), lastUsedAt: hoursAgo(31) }] },
      NOW
    );
    expect(gone[0]!.title).toBe('The agent token "claw" expired 30 h ago');
    expect(gone[0]!.tier).toBe("blocking");
    expect(
      recordingItems(
        { ...quiet, agentTokens: [{ name: "claw", expiresAt: hoursAgo(-24 * 8), lastUsedAt: hoursAgo(2) }] },
        NOW
      )
    ).toEqual([]);
  });

  it("raises nothing for an abandoned token: never used, or last used over 30 days ago", () => {
    const expired = hoursAgo(24 * 3);
    const none = (lastUsedAt: string | null) => ({
      ...quiet,
      agentTokens: [{ name: "old", expiresAt: expired, lastUsedAt }]
    });
    expect(recordingItems(none(null), NOW)).toEqual([]);
    expect(recordingItems(none(hoursAgo(24 * 31)), NOW)).toEqual([]);
    expect(recordingItems(none(hoursAgo(24 * 29)), NOW).map((i) => i.id)).toEqual(["agent_token_expiring:old"]);
    const unusedSoon = { name: "new", expiresAt: hoursAgo(-24 * 3), lastUsedAt: null };
    expect(recordingItems({ ...quiet, agentTokens: [unusedSoon] }, NOW)).toEqual([]);
  });

  it("flags reported agent time silent for 7 days only once it has been seen (D-D16)", () => {
    const silent = recordingItems({ ...quiet, agentTime: { lastReportedAt: hoursAgo(24 * 8) } }, NOW);
    expect(silent.map((i) => [i.id, i.tier])).toEqual([["agent_time_silent", "degrading"]]);
    expect(recordingItems({ ...quiet, agentTime: { lastReportedAt: hoursAgo(24 * 6) } }, NOW)).toEqual([]);
    expect(recordingItems({ ...quiet, agentTime: { lastReportedAt: null } }, NOW)).toEqual([]);
  });

  it("raises both items for an expired token and eight days without agent time", () => {
    const items = recordingItems(
      {
        ...quiet,
        agentTokens: [{ name: "claw", expiresAt: hoursAgo(24), lastUsedAt: hoursAgo(26) }],
        agentTime: { lastReportedAt: hoursAgo(24 * 8) }
      },
      NOW
    );
    expect(items.map((i) => i.check).sort()).toEqual(["agent_time_silent", "agent_token_expiring"]);
  });
});
