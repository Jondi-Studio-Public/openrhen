import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { runActivityImport } from "../src/commands/import-activity.js";
import { CliError, EXIT } from "../src/errors.js";
import { fakeFetch, type FakeResponse, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow } from "./fixture-state.js";

const dir = mkdtempSync(join(tmpdir(), "cli-activity-import-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Route = FakeResponse | ((call: RecordedCall) => FakeResponse);

async function run(argv: readonly string[], routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch(routes, calls)
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A stand-in for the portal: holds event ids per source, can reject by kind, and records what it was sent. */
function fakePortal(options: { held?: boolean; failOnBatch?: number; rejectStartingAfter?: string } = {}) {
  const seen = new Set<string>();
  const batches: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const routes: Record<string, Route> = {
    "/api/activity-imports/runs": (call) => {
      runs.push(call.body as Record<string, unknown>);
      return { body: { recorded: true } };
    },
    "/api/activity-imports": () => ({
      body: options.held
        ? { held: true, importId: "11111111-1111-4111-8111-111111111111", eventCount: 42 }
        : { held: false }
    }),
    "/api/activity-events": (call) => {
      const body = call.body as { events: { id: string; start: string }[]; importId?: string };
      batches.push(body as unknown as Record<string, unknown>);
      if (options.failOnBatch === batches.length) return { status: 500, body: { error: "database is down" } };
      let added = 0;
      let alreadyHeld = 0;
      const rejected: { index: number; reason: string }[] = [];
      body.events.forEach((event, index) => {
        if (options.rejectStartingAfter && event.start > options.rejectStartingAfter) {
          rejected.push({
            index,
            reason: `start (${event.start}) is more than 24 hours in the future. Check the device clock and time zone.`
          });
        } else if (seen.has(event.id)) alreadyHeld += 1;
        else {
          seen.add(event.id);
          added += 1;
        }
      });
      return {
        body: {
          added,
          alreadyHeld,
          contentDropped: 0,
          rejected,
          importId: body.importId ?? "22222222-2222-4222-8222-222222222222"
        }
      };
    }
  };
  return { routes, batches, seen, runs };
}

const play = (n: number, extra: Record<string, unknown> = {}) => ({
  ts: new Date(Date.UTC(2026, 3, 5, 6, 0, 0) + n * 1000).toISOString(),
  ms_played: 1000,
  spotify_track_uri: `spotify:track:${String(n).padStart(22, "a")}`,
  ...extra
});

describe("rhen import <source> <path>", () => {
  it("checks whether the file is held, then posts the first batch with the import object and counts the result", async () => {
    const file = write(
      join(dir, "one", "Streaming_History_Audio_2026_0.json"),
      JSON.stringify([play(1), play(2), play(3)])
    );
    const portal = fakePortal();
    const result = await run(["import", "spotify", file], portal.routes);
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/activity-imports",
      "POST /api/activity-events",
      "POST /api/activity-imports/runs"
    ]);
    expect(result.calls[0]!.url).toContain(`sha256=${sha(file)}`);
    const body = result.calls[1]!.body as { schema: number; import: unknown; events: { source: string }[] };
    expect(body.schema).toBe(1);
    expect(body.import).toEqual({
      sha256: sha(file),
      filename: "Streaming_History_Audio_2026_0.json",
      source: "spotify"
    });
    expect(body.events).toHaveLength(3);
    expect(result.stdout).toContain(
      "spotify (Streaming_History_Audio_2026_0.json): read 3 rows; sent 3: added 3, already held 0, rejected 0"
    );
  });

  it("sends at most 1000 events per batch, and later batches carry importId instead of import", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => play(i));
    const file = write(join(dir, "many", "Streaming_History_Audio_2026_1.json"), JSON.stringify(rows));
    const portal = fakePortal();
    const result = await run(["import", "spotify", file], portal.routes);
    expect(result.exitCode).toBe(0);
    expect(portal.batches.map((b) => (b.events as unknown[]).length)).toEqual([1000, 1000, 500]);
    expect(portal.batches[0]).toHaveProperty("import");
    expect(portal.batches[1]).toMatchObject({ importId: "22222222-2222-4222-8222-222222222222" });
    expect(portal.batches[1]).not.toHaveProperty("import");
    expect(result.stdout).toContain("added 2500");
  });

  it("keeps each batch under the 2 MB body limit when events are large", async () => {
    const names = "x".repeat(300_000);
    const rows = Array.from({ length: 12 }, (_, i) => play(i, { master_metadata_track_name: names }));
    const file = write(join(dir, "big", "Streaming_History_Audio_2026_2.json"), JSON.stringify(rows));
    const portal = fakePortal();
    const result = await run(["import", "spotify", file], portal.routes);
    expect(result.exitCode).toBe(0);
    expect(portal.batches.length).toBeGreaterThan(1);
    for (const batch of portal.batches) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(2 * 1024 * 1024);
    expect(portal.batches.flatMap((b) => b.events as unknown[])).toHaveLength(12);
  });

  it("prints every rejection reason with its count and where it first happened", async () => {
    const file = write(
      join(dir, "rej", "Streaming_History_Audio_2026_3.json"),
      JSON.stringify([play(1), play(500), play(600), { ts: "bad", ms_played: 1 }])
    );
    const portal = fakePortal({ rejectStartingAfter: play(100).ts });
    const result = await run(["import", "spotify", file], portal.routes);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rejected 2");
    expect(result.stdout).toMatch(
      /rejected 2: start \(.*\) is more than 24 hours in the future\. Check the device clock and time zone\. \(first at event 2\)/
    );
    expect(result.stdout).toContain("skipped 1: ts is missing or has no time zone");
  });

  it("does not send a file the portal already holds, unless --yes", async () => {
    const file = write(join(dir, "held", "Streaming_History_Audio_2026_4.json"), JSON.stringify([play(1)]));
    const held = await run(["import", "spotify", file], fakePortal({ held: true }).routes);
    expect(held.exitCode).toBe(0);
    expect(held.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(held.calls.some((c) => c.path.endsWith("/runs"))).toBe(false);
    expect(held.stdout).toContain("already holds an import of this file (42 events");
    expect(held.stdout).toContain("may have been interrupted");
    expect(held.stdout).toContain("--yes to resume");
    const again = await run(["import", "spotify", file, "--yes"], fakePortal({ held: true }).routes);
    expect(again.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
  });

  it("drops and counts a single event over 1 MB instead of sending it", async () => {
    const rows = [play(1), play(2, { master_metadata_track_name: "x".repeat(2_000_000) }), play(3)];
    const file = write(join(dir, "huge", "Streaming_History_Audio_2026_8.json"), JSON.stringify(rows));
    const portal = fakePortal();
    const result = await run(["import", "spotify", file], portal.routes);
    expect(result.exitCode).toBe(0);
    expect(portal.batches.flatMap((b) => b.events as unknown[])).toHaveLength(2);
    expect(result.stdout).toContain("skipped 1: event is larger than 1 MB, so it was not sent");
  });

  it("warns, with the top skipped reason, when a matched file gives no events or mostly skipped rows, and notes unverified sources", async () => {
    const rows = [
      { title: "Used Maps", time: "2026-02-03T04:05:07Z" },
      { title: "Used Search", time: "2026-02-03T04:05:08Z" }
    ];
    const file = write(join(dir, "Search2", "MyActivity.json"), JSON.stringify(rows));
    const result = await run(["import", "google-activity", file, "--dry-run"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WARNING google-activity: read 2 rows but produced no events from MyActivity.json");
    expect(result.stdout).toContain(
      'The commonest reason: "title starts with a verb this importer does not know" (2 rows)'
    );
    expect(result.stdout).toContain("Do not send the file's contents");
    const photo = write(
      join(dir, "Takeout", "Google Photos", "Trip", "a.jpg.json"),
      JSON.stringify({ title: "a.jpg" })
    );
    const unverified = await run(["import", "google-photos", photo, "--dry-run"], {});
    expect(unverified.stdout).toContain("WARNING google-photos:");
    expect(unverified.stderr).toContain("google-photos: format not yet checked against a real Takeout");
    const fine = write(
      join(dir, "Search3", "MyActivity.json"),
      JSON.stringify([{ title: "Searched for a", time: "2026-02-03T04:05:07Z" }])
    );
    expect((await run(["import", "google-activity", fine, "--dry-run"], {})).stdout).not.toContain("WARNING");
  });

  it("fails with the keys seen when a Timeline file is wrapped in an unknown object", async () => {
    const file = write(join(dir, "wrapped", "Records.json"), JSON.stringify({ data: { locations: [] } }));
    const result = await run(["import", "timeline", file, "--dry-run"], {});
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('top-level keys are "data"');
  });

  it("names the commonest title verbs it skipped in My Activity", async () => {
    const rows = [
      { title: "Searched for a", time: "2026-02-03T04:05:06Z" },
      { title: "Used Maps", time: "2026-02-03T04:05:07Z" },
      { title: "Used Search", time: "2026-02-03T04:05:08Z" },
      { title: "Listened to x", time: "2026-02-03T04:05:09Z" }
    ];
    const file = write(join(dir, "Search", "MyActivity.json"), JSON.stringify(rows));
    const result = await run(["import", "google-activity", file, "--dry-run"], {});
    expect(result.stdout).toContain("commonest skipped title verbs: Used (2), Listened (1)");
  });

  it("says which import to undo when a zip entry fails its checksum after events were sent", async () => {
    const body = Buffer.from(JSON.stringify(Array.from({ length: 1500 }, (_, i) => play(i))));
    const name = Buffer.from("Streaming_History_Audio_2026_9.json");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0xdeadbeef, 14); // a checksum that is wrong
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(0xdeadbeef, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    const directoryOffset = local.length + name.length + body.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(entry.length + name.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    const path = join(dir, "badcrc.zip");
    writeFileSync(path, Buffer.concat([local, name, body, entry, name, end]));
    const result = await run(["import", "spotify", path], fakePortal().routes);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("fails its checksum");
    expect(result.stderr).toContain("stopped after 1000 events were sent");
    expect(result.stderr).toContain("DELETE /api/activity-imports/22222222-2222-4222-8222-222222222222");
  });

  it("--dry-run parses and counts without any request", async () => {
    const file = write(join(dir, "dry", "Streaming_History_Audio_2026_5.json"), JSON.stringify([play(1), play(2)]));
    const result = await run(["import", "spotify", file, "--dry-run"], {});
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain("dry run, nothing sent. Read 2 rows; 2 would be sent");
  });

  it("stops with the portal's error and says how to resume when a batch fails", async () => {
    const file = write(
      join(dir, "fail", "Streaming_History_Audio_2026_6.json"),
      JSON.stringify(Array.from({ length: 1500 }, (_, i) => play(i)))
    );
    const result = await run(["import", "spotify", file], fakePortal({ failOnBatch: 2 }).routes);
    expect(result.exitCode).toBe(EXIT.unavailable);
    expect(result.stderr).toContain("again with --yes");
  });

  it("sends a Takeout's YouTube history to the watch-history route and the rest to the activity store", async () => {
    const root = join(dir, "takeout");
    write(
      join(root, "Takeout", "Chrome", "BrowserHistory.json"),
      JSON.stringify({
        "Browser History": [
          { url: "https://example.test/", title: "T", time_usec: 1767323045000000, page_transition: "LINK" }
        ]
      })
    );
    const history = JSON.stringify([
      { title: "Watched x", titleUrl: "https://www.youtube.com/watch?v=abcdefghijk", time: "2026-02-03T04:05:06Z" }
    ]);
    write(join(root, "Takeout", "YouTube and YouTube Music", "history", "watch-history.json"), history);
    const portal = fakePortal();
    const result = await run(["import", "takeout", root], {
      ...portal.routes,
      "/api/imports/watch-history": {
        body: {
          importId: "33333333-3333-4333-8333-333333333333",
          read: 1,
          added: 1,
          alreadyHeld: 0,
          skipped: 0,
          watches: 1,
          ads: 0,
          posts: 0,
          music: 0
        }
      }
    });
    expect(result.exitCode).toBe(0);
    const youtube = result.calls.find((c) => c.path === "/api/imports/watch-history")!;
    expect(youtube.body).toEqual({
      filename: "watch-history.json",
      encoding: "base64",
      data: Buffer.from(history).toString("base64")
    });
    expect(portal.batches).toHaveLength(1);
    expect(result.stderr).toContain("No My Activity/<product>/MyActivity.json found");
    expect(result.stdout).toContain("chrome-takeout");
    expect(result.stdout).toContain("youtube (");
  });

  it("prints machine-readable counts with --json", async () => {
    const file = write(join(dir, "json", "Streaming_History_Audio_2026_7.json"), JSON.stringify([play(1)]));
    const result = await run(["import", "spotify", file, "--json"], fakePortal().routes);
    const parsed = JSON.parse(result.stdout) as { sources: { source: string; added: number; status: string }[] };
    expect(parsed.sources[0]).toMatchObject({ source: "spotify", added: 1, status: "imported" });
  });

  it("names the expected file when the export has none for the source, and a missing path", async () => {
    const empty = write(join(dir, "none", "other.json"), "[]");
    const wrong = await run(["import", "apple-health", dir + "/none"], {});
    expect(wrong.exitCode).toBe(EXIT.usage);
    expect(wrong.stderr).toContain("No apple_health_export/export.xml found");
    expect(empty).toBeTruthy();
    const missing = await run(["import", "spotify", join(dir, "nope.zip")], {});
    expect(missing.exitCode).toBe(EXIT.usage);
    expect(missing.stderr).toContain("does not exist");
    const noPath = await run(["import", "spotify"], {});
    expect(noPath.exitCode).toBe(EXIT.usage);
    expect(noPath.stderr).toContain("Missing <path>");
  });

  it("keeps the reviewed-batch actions and lists the sources in the unknown-action error", async () => {
    const result = await run(["import", "whatever"], {});
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain(
      "takeout, chrome, google-activity, maps, fit, timeline, google-chat, access-log, google-photos, youtube, spotify, discord, apple-health"
    );
  });

  it("refuses to read a local file for an MCP caller", async () => {
    const context = { mcp: true } as never;
    await expect(
      runActivityImport(context, { positionals: ["spotify", "/etc/passwd"], values: {} })
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("rhen import run rows", () => {
  it("posts one run per job: synced when clean, needs_review when rows were skipped or rejected", async () => {
    const clean = write(
      join(dir, "runs", "a", "Streaming_History_Audio_2026_0.json"),
      JSON.stringify([play(1), play(2)])
    );
    const portal = fakePortal();
    expect((await run(["import", "spotify", clean], portal.routes)).exitCode).toBe(0);
    expect(portal.runs).toHaveLength(1);
    expect(portal.runs[0]).toMatchObject({
      source: "spotify",
      status: "synced",
      summary: {
        file: "Streaming_History_Audio_2026_0.json",
        events: 2,
        skipped: 0,
        rejected: 0,
        truncated: 0,
        warnings: []
      }
    });
    expect(Date.parse(portal.runs[0]!.startedAt as string)).not.toBeNaN();
    expect(Date.parse(portal.runs[0]!.finishedAt as string)).not.toBeNaN();

    const skipping = write(
      join(dir, "runs", "b", "Streaming_History_Audio_2026_1.json"),
      JSON.stringify([play(1), { ts: "bad", ms_played: 1 }])
    );
    const second = fakePortal();
    await run(["import", "spotify", skipping], second.routes);
    expect(second.runs[0]).toMatchObject({ status: "needs_review", summary: { skipped: 1, events: 1 } });

    const rejecting = write(
      join(dir, "runs", "c", "Streaming_History_Audio_2026_2.json"),
      JSON.stringify([play(1), play(500)])
    );
    const third = fakePortal({ rejectStartingAfter: play(100).ts });
    await run(["import", "spotify", rejecting], third.routes);
    expect(third.runs[0]).toMatchObject({ status: "needs_review", summary: { rejected: 1 } });
  });

  it("keeps going after a failing job, posts a failed run for it, and exits non-zero at the end", async () => {
    const root = join(dir, "runs", "takeout");
    write(
      join(root, "Takeout", "Chrome", "BrowserHistory.json"),
      JSON.stringify({
        "Browser History": [
          { url: "https://example.test/", title: "T", time_usec: 1767323045000000, page_transition: "LINK" }
        ]
      })
    );
    write(
      join(root, "Takeout", "Location History (Timeline)", "Records.json"),
      JSON.stringify({ data: { locations: [] } })
    );
    const history = JSON.stringify([
      { title: "Watched x", titleUrl: "https://www.youtube.com/watch?v=abcdefghijk", time: "2026-02-03T04:05:06Z" }
    ]);
    write(join(root, "Takeout", "YouTube and YouTube Music", "history", "watch-history.json"), history);
    const portal = fakePortal();
    const result = await run(["import", "takeout", root], {
      ...portal.routes,
      "/api/imports/watch-history": {
        body: { importId: null, read: 1, added: 1, alreadyHeld: 0, skipped: 0, watches: 1, ads: 0, posts: 0, music: 0 }
      }
    });
    expect(result.exitCode).not.toBe(0);
    const bySource = Object.fromEntries(portal.runs.map((r) => [r.source as string, r]));
    expect(bySource["timeline"]).toMatchObject({ status: "failed", summary: { events: 0 } });
    expect((bySource["timeline"]!.summary as { error: string }).error).toContain('top-level keys are "data"');
    expect(bySource["chrome-takeout"]).toMatchObject({ status: "synced" });
    expect(bySource["youtube-watch-history"]).toMatchObject({ status: "synced", summary: { events: 1 } });
    expect(portal.runs.map((r) => r.source)).toEqual(["chrome-takeout", "timeline", "youtube-watch-history"]);
    // The job after the failing one still ran, and the summaries of the ones that worked were printed.
    expect(result.stdout).toContain("chrome-takeout");
    expect(result.stderr).toContain('top-level keys are "data"');
  });

  it("warns once and carries on when the run cannot be posted, and never fails the import for it", async () => {
    const file = write(join(dir, "runs", "d", "Streaming_History_Audio_2026_3.json"), JSON.stringify([play(1)]));
    const { routes } = fakePortal();
    delete routes["/api/activity-imports/runs"];
    const result = await run(["import", "spotify", file], routes);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("added 1");
    expect(result.stderr.match(/could not record the run/g)).toHaveLength(1);
  });

  it("posts nothing for a dry run", async () => {
    const file = write(join(dir, "runs", "e", "Streaming_History_Audio_2026_4.json"), JSON.stringify([play(1)]));
    const portal = fakePortal();
    await run(["import", "spotify", file, "--dry-run"], portal.routes);
    expect(portal.runs).toEqual([]);
  });
});
