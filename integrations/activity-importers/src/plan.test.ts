import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collect, makeZip } from "./fixtures.js";
import { planImport } from "./plan.js";
import { ImportReadError } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "activity-plan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const takeout = makeZip([
  {
    name: "Takeout/Chrome/BrowserHistory.json",
    data: JSON.stringify({ "Browser History": [{ url: "https://example.test/", time_usec: 1767323045000000 }] })
  },
  {
    name: "Takeout/My Activity/Search/MyActivity.json",
    data: JSON.stringify([{ title: "Searched for x", time: "2026-02-03T04:05:06Z" }])
  },
  {
    name: "Takeout/My Activity/YouTube/MyActivity.json",
    data: JSON.stringify([{ title: "Watched y", time: "2026-02-03T04:05:06Z" }])
  },
  { name: "Takeout/Maps (your places)/Saved Places.json", data: JSON.stringify({ features: [] }) },
  { name: "Takeout/YouTube and YouTube Music/history/watch-history.json", data: "[]" },
  {
    name: "Takeout/Fit/Daily activity metrics/2026-01-02.csv",
    data: "Start time,End time,Step count\n00:00:00.000Z,00:15:00.000Z,5\n"
  }
]);

describe("planImport", () => {
  it("finds every Takeout product, hands YouTube to the watch-history route, and never parses it here", async () => {
    const path = join(dir, "takeout.zip");
    writeFileSync(path, takeout);
    const plan = await planImport("takeout", path);
    expect(plan.jobs.map((job) => job.source)).toEqual([
      "chrome-takeout",
      "google-activity",
      "maps-places",
      "fit",
      "youtube"
    ]);
    const youtube = plan.jobs.find((job) => job.kind === "youtube")!;
    expect(youtube).toMatchObject({ file: "Takeout/YouTube and YouTube Music/history/watch-history.json", size: 2 });
    expect(Buffer.from(await (youtube as { read(): Promise<Uint8Array> }).read()).toString()).toBe("[]");
    const counts: Record<string, number> = {};
    for (const job of plan.jobs) if (job.kind === "events") counts[job.source] = (await collect(job.events())).length;
    expect(counts).toEqual({ "chrome-takeout": 1, "google-activity": 1, "maps-places": 0, fit: 1 });
  });

  it("finds the Timeline, Google Chat, Access Log and Photos files by name, reads only photo sidecars, and reports products not found", async () => {
    const path = join(dir, "takeout-new.zip");
    const media = Buffer.from("MEDIA-BYTES-MUST-NOT-BE-READ");
    writeFileSync(
      path,
      makeZip([
        {
          name: "Takeout/Location History (Timeline)/Records.json",
          data: JSON.stringify({ locations: [{ timestampMs: "1767323045123", latitudeE7: 1, longitudeE7: 2 }] })
        },
        {
          name: "Takeout/Location History (Timeline)/Semantic Location History/2026/2026_JANUARY.json",
          data: JSON.stringify({ timelineObjects: [] })
        },
        {
          name: "Takeout/Google Chat/Users/User 1/user_info.json",
          data: JSON.stringify({ user: { email: "me@example.test" } })
        },
        {
          name: "Takeout/Google Chat/Groups/Space AAA/messages.json",
          data: JSON.stringify({
            messages: [
              {
                creator: { email: "me@example.test" },
                created_date: "Monday, January 2, 2023 at 3:04:05 PM UTC",
                message_id: "AAA/1",
                text: "hi"
              }
            ]
          })
        },
        { name: "Takeout/Google Chat/Groups/Space AAA/group_info.json", data: "{}" },
        {
          name: "Takeout/Access Log Activity/Activities - A list of Google services accessed by.csv",
          data: "Activity Timestamp,Product Name,IP Address\n2026-01-02 03:04:05 UTC,Gmail,1.2.3.4\n"
        },
        { name: "Takeout/Access Log Activity/Devices - A list of devices that have accessed.csv", data: "x\n" },
        { name: "Takeout/Google Photos/Trip/IMG_1.jpg", data: media },
        {
          name: "Takeout/Google Photos/Trip/IMG_1.jpg.json",
          data: JSON.stringify({ title: "IMG_1.jpg", photoTakenTime: { timestamp: "1767323045" } })
        },
        { name: "Takeout/Google Photos/Trip/metadata.json", data: JSON.stringify({ title: "Trip" }) }
      ])
    );
    const plan = await planImport("takeout", path);
    expect(plan.jobs.map((job) => job.source)).toEqual([
      "timeline",
      "google-chat",
      "google-access-log",
      "google-photos"
    ]);
    expect(plan.notes.filter((note) => note.startsWith("No ")).length).toBe(5);
    const counts: Record<string, number> = {};
    const files: Record<string, string[]> = {};
    for (const job of plan.jobs) {
      if (job.kind !== "events") continue;
      const events = await collect(job.events());
      counts[job.source] = events.length;
      files[job.source] = job.files;
      expect(JSON.stringify(events)).not.toContain("MEDIA-BYTES");
      expect(JSON.stringify(events)).not.toContain("1.2.3.4");
    }
    expect(counts).toEqual({ timeline: 1, "google-chat": 1, "google-access-log": 1, "google-photos": 1 });
    expect(files["google-photos"]).toEqual(["Takeout/Google Photos/Trip/IMG_1.jpg.json"]);
    expect(files["google-access-log"]).toHaveLength(1);
  });

  it("records each source of one zip under its own hash, and a bare file under its own", async () => {
    const path = join(dir, "takeout2.zip");
    writeFileSync(path, takeout);
    const plan = await planImport("takeout", path);
    const jobs = plan.jobs.filter((job) => job.kind === "events");
    const hashes = await Promise.all(jobs.map((job) => plan.sha256For(job)));
    expect(new Set(hashes).size).toBe(jobs.length);
    const again = await planImport("takeout", path);
    expect(
      await Promise.all(again.jobs.filter((job) => job.kind === "events").map((job) => again.sha256For(job)))
    ).toEqual(hashes);

    const bare = join(dir, "Streaming_History_Audio_2026_0.json");
    writeFileSync(bare, "[]");
    const spotify = await planImport("spotify", bare);
    const { sha256File } = await import("./archive.js");
    expect(await spotify.sha256For(spotify.jobs[0] as never)).toBe(await sha256File(bare));
  });

  it("reads one source out of a zip, taking the Discord folder name as the channel id and preferring the csv", async () => {
    const path = join(dir, "discord.zip");
    writeFileSync(
      path,
      makeZip([
        { name: "package/messages/index.json", data: "{}" },
        {
          name: "package/messages/c3300000000000000001/messages.csv",
          data: "ID,Timestamp,Contents,Attachments\n1100000000000000001,2026-01-02 03:04:05+00:00,hi,\n"
        },
        { name: "package/messages/c3300000000000000001/messages.json", data: "[]" },
        {
          name: "package/messages/c3300000000000000002/messages.json",
          data: JSON.stringify([
            { ID: "1100000000000000002", Timestamp: "2026-01-02 03:04:06+00:00", Contents: "yo", Attachments: "" }
          ])
        },
        { name: "package/messages/weird/messages.csv", data: "ID,Timestamp\n1,2\n" }
      ])
    );
    const plan = await planImport("discord", path);
    const job = plan.jobs[0]!;
    if (job.kind !== "events") throw new Error("expected an event job");
    const events = await collect(job.events());
    expect(events.map((e) => e.attrs.thread_id).sort()).toEqual(["3300000000000000001", "3300000000000000002"]);
    expect(job.stats.reasons).toEqual({ "channel folder name is not a channel id": 1 });
  });

  it("says what it looked for when the source is not in the file, and refuses a lone file for takeout", async () => {
    const path = join(dir, "empty.zip");
    writeFileSync(path, makeZip([{ name: "a/b.txt", data: "x" }]));
    await expect(planImport("spotify", path)).rejects.toThrow(/No Streaming_History_Audio_\*\.json found/);
    await expect(planImport("takeout", path)).rejects.toThrow(ImportReadError);
    const bare = join(dir, "BrowserHistory.json");
    writeFileSync(bare, "{}");
    await expect(planImport("takeout", bare)).rejects.toThrow(/single file/);
  });

  it("tells the user when two zip parts carry the same path", async () => {
    const folder = join(dir, "parts");
    mkdirSync(folder);
    const chrome = JSON.stringify({ "Browser History": [] });
    writeFileSync(join(folder, "a.zip"), makeZip([{ name: "Takeout/Chrome/BrowserHistory.json", data: chrome }]));
    writeFileSync(join(folder, "b.zip"), makeZip([{ name: "Takeout/Chrome/BrowserHistory.json", data: chrome }]));
    const plan = await planImport("takeout", folder);
    expect(plan.notes.some((note) => /1 path.*more than one zip.*first copy/.test(note))).toBe(true);
  });

  it("reads a bare My Activity file with the folder it sits in as the product", async () => {
    const folder = join(dir, "Search");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder);
    const file = join(folder, "MyActivity.json");
    writeFileSync(file, JSON.stringify([{ title: "Searched for q", time: "2026-02-03T04:05:06Z" }]));
    const plan = await planImport("google-activity", file);
    const job = plan.jobs[0]!;
    if (job.kind !== "events") throw new Error("expected an event job");
    expect((await collect(job.events()))[0]!.attrs).toEqual({ product: "Search" });
  });
});
