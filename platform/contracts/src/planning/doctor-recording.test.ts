import { describe, expect, it } from "vitest";
import { recordingItems, type DoctorRecordingSlice } from "./doctor-recording.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const quiet: DoctorRecordingSlice = {
  backup: { status: "synced", lastRunAt: hoursAgo(5), lastSuccessAt: hoursAgo(5) },
  phonePing: { configured: true, lastPingAt: hoursAgo(2) }
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
});
