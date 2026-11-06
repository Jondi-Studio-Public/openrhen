import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  parseTakeoutTime,
  parseWatchHistoryJson,
  parseWatchHistoryUpload,
  syntheticVideoId,
  videoIdFromUrl,
  WatchHistoryParseError
} from "./watch-history-parser";

const watch = (extra: Record<string, unknown> = {}) => ({
  header: "YouTube",
  title: "Watched Cats being cats",
  titleUrl: "https://www.youtube.com/watch?v=abcDEF12345",
  subtitles: [{ name: "Cat Channel", url: "https://www.youtube.com/channel/UC1" }],
  time: "2026-11-01T10:15:30.123Z",
  products: ["YouTube"],
  ...extra
});
const parse = (entries: unknown[]) => parseWatchHistoryJson(JSON.stringify(entries));

describe("parseTakeoutTime", () => {
  it("reads Z, offsets, and with or without fractional seconds, flooring to the second", () => {
    expect(parseTakeoutTime("2026-11-01T10:15:30.987Z")?.toISOString()).toBe("2026-11-01T10:15:30.000Z");
    expect(parseTakeoutTime("2026-11-01T10:15:30Z")?.toISOString()).toBe("2026-11-01T10:15:30.000Z");
    expect(parseTakeoutTime("2026-11-01T12:15:30+02:00")?.toISOString()).toBe("2026-11-01T10:15:30.000Z");
    expect(parseTakeoutTime("2026-11-01T05:15:30.5-0500")?.toISOString()).toBe("2026-11-01T10:15:30.000Z");
  });

  it("refuses a missing, malformed or zone-less time", () => {
    for (const bad of [
      undefined,
      null,
      5,
      "",
      "yesterday",
      "2026-11-01T10:15:30",
      "2026-13-45T10:15:30Z",
      "2026-02-30T10:15:30Z",
      "2004-12-31T23:59:59Z",
      "2099-01-01T00:00:00Z"
    ])
      expect(parseTakeoutTime(bad)).toBeNull();
  });
});

describe("videoIdFromUrl", () => {
  it("finds the id in watch, music, youtu.be and Shorts addresses and nothing in posts or channels", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=abcDEF12345&t=3")).toBe("abcDEF12345");
    expect(videoIdFromUrl("https://music.youtube.com/watch?v=abcDEF12345")).toBe("abcDEF12345");
    expect(videoIdFromUrl("https://youtu.be/abcDEF12345")).toBe("abcDEF12345");
    expect(videoIdFromUrl("https://www.youtube.com/shorts/abcDEF12345")).toBe("abcDEF12345");
    expect(videoIdFromUrl("https://www.youtube.com/post/Ugkx123")).toBeNull();
    expect(videoIdFromUrl("https://www.youtube.com/channel/UC1")).toBeNull();
    expect(videoIdFromUrl("https://evil.example/watch?v=abcDEF12345")).toBeNull();
    expect(videoIdFromUrl(undefined)).toBeNull();
  });
});

describe("parseWatchHistoryJson", () => {
  it("parses a watch: prefix stripped, id from the address, channel from the subtitles", () => {
    expect(parse([watch()]).events).toEqual([
      {
        source: "youtube_takeout",
        kind: "watch",
        videoId: "abcDEF12345",
        watchedAt: new Date("2026-11-01T10:15:30.000Z"),
        dupIndex: 0,
        title: "Cats being cats",
        channel: "Cat Channel"
      }
    ]);
  });

  it("skips entries with no time and counts them", () => {
    const { events, skipped } = parse([watch({ time: undefined }), watch({ time: "nonsense" }), "text", null, watch()]);
    expect(events).toHaveLength(1);
    expect(skipped).toBe(4);
  });

  it("strips NUL characters from titles and channels", () => {
    const [event] = parse([watch({ title: "Watched Ca\u0000ts", subtitles: [{ name: "Ch\u0000an" }] })]).events;
    expect(event).toMatchObject({ title: "Cats", channel: "Chan" });
  });

  it("keeps a removed video, with the address as its id source and no title", () => {
    const removed = {
      header: "YouTube",
      title: "Watched https://www.youtube.com/watch?v=gone1234567",
      titleUrl: "https://www.youtube.com/watch?v=gone1234567",
      time: "2026-11-01T09:00:00Z"
    };
    expect(parse([removed]).events[0]).toMatchObject({
      kind: "watch",
      videoId: "gone1234567",
      title: null,
      channel: null
    });
  });

  it("gives a watch with no address a stable synthetic id", () => {
    const orphan = { header: "YouTube", title: "Watched A video that has been removed", time: "2026-11-01T09:00:00Z" };
    const [first] = parse([orphan]).events;
    expect(first).toMatchObject({ kind: "watch", title: "A video that has been removed" });
    expect(first!.videoId).toMatch(/^x:[0-9a-f]{24}$/);
    expect(first!.videoId).toBe(syntheticVideoId(undefined, orphan.title));
    expect(parse([{ ...orphan, title: "Watched Another" }]).events[0]!.videoId).not.toBe(first!.videoId);
  });

  it("classifies ads by details and posts by a non-video address; neither is a watch", () => {
    const ad = watch({ title: "Watched Buy things", details: [{ name: "From Google Ads" }] });
    const post = {
      header: "YouTube",
      title: "Viewed post by Someone",
      titleUrl: "https://www.youtube.com/post/UgkxABC",
      time: "2026-11-01T08:00:00Z"
    };
    const { events } = parse([ad, post]);
    expect(events.map((event) => event.kind)).toEqual(["ad", "post"]);
    expect(events[1]!.videoId).toMatch(/^x:/);
  });

  it("marks YouTube Music entries with their own source", () => {
    const music = watch({
      header: "YouTube Music",
      title: "Watched A song",
      titleUrl: "https://music.youtube.com/watch?v=song1234567"
    });
    expect(parse([music]).events[0]).toMatchObject({
      source: "youtube_music_takeout",
      kind: "watch",
      videoId: "song1234567"
    });
  });

  it("numbers same-second repeats of one video, and the same file parses to the same keys again", () => {
    const entries = [
      watch(),
      watch({ time: "2026-11-01T10:15:30.900Z" }),
      watch({ time: "2026-11-01T10:15:30Z" }),
      watch({ time: "2026-11-01T10:15:31Z" })
    ];
    const first = parse(entries).events.map((event) => event.dupIndex);
    expect(first).toEqual([0, 1, 2, 0]);
    expect(parse(entries).events.map((event) => event.dupIndex)).toEqual(first);
  });

  it("tolerates a byte-order mark and refuses non-JSON and non-lists with a plain message", () => {
    expect(parseWatchHistoryJson(`\uFEFF${JSON.stringify([watch()])}`).events).toHaveLength(1);
    expect(() => parseWatchHistoryJson("<html></html>")).toThrow(/not valid JSON/);
    expect(() => parseWatchHistoryJson("{}")).toThrow(WatchHistoryParseError);
  });
});

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

describe("parseWatchHistoryUpload", () => {
  const json = JSON.stringify([watch()]);

  it("reads a bare JSON file", async () => {
    expect((await parseWatchHistoryUpload(new TextEncoder().encode(json))).events).toHaveLength(1);
  });

  it("finds the history file in a Takeout zip by path suffix, whatever the folder is called", async () => {
    for (const folder of ["Takeout/YouTube and YouTube Music", "Takeout/YouTube et YouTube Music"]) {
      const bytes = await zipOf({
        [`${folder}/history/watch-history.json`]: json,
        [`${folder}/history/search-history.json`]: "[]"
      });
      expect((await parseWatchHistoryUpload(bytes)).events).toHaveLength(1);
    }
  });

  it("explains a zip with no history file, and one with several", async () => {
    await expect(parseWatchHistoryUpload(await zipOf({ "Takeout/other.json": "[]" }))).rejects.toThrow(
      /No watch-history\.json/
    );
    await expect(
      parseWatchHistoryUpload(
        await zipOf({ "a/history/watch-history.json": json, "b/history/watch-history.json": json })
      )
    ).rejects.toThrow(/more than one/);
  });

  it("refuses bytes that start like a zip but are not one", async () => {
    await expect(parseWatchHistoryUpload(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).rejects.toThrow(/not a readable zip/);
  });
});
