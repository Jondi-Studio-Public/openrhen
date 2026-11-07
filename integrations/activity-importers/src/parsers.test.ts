import { describe, expect, it } from "vitest";
import { chunked, collect } from "./fixtures.js";
import { parseAppleDate, parseAppleHealth } from "./parsers/apple-health.js";
import { parseChromeHistory } from "./parsers/chrome.js";
import { channelIdFromFolder, parseDiscordMessagesCsv, parseDiscordMessagesJson } from "./parsers/discord.js";
import { parseFitMetrics } from "./parsers/fit.js";
import { parseGoogleActivity } from "./parsers/google-activity.js";
import { parseMapsPlaces } from "./parsers/maps.js";
import { parseSpotifyHistory } from "./parsers/spotify.js";
import { newStats } from "./types.js";

const now = new Date("2026-11-07T00:00:00Z");

describe("Chrome BrowserHistory.json", () => {
  const file = JSON.stringify({
    "Browser History": [
      {
        page_transition: "LINK",
        title: "Example  page",
        url: "https://example.test/a",
        time_usec: 1767323045123456,
        client_id: "c"
      },
      { page_transition: "TYPED", title: "", url: "https://example.test/b", time_usec: "1767323046000000" },
      { page_transition: "LINK", title: "Twin", url: "https://example.test/c", time_usec: 1767323047000000 },
      { page_transition: "LINK", title: "Twin", url: "https://example.test/c", time_usec: 1767323047000000 },
      { title: "no url", time_usec: 1767323048000000 },
      { url: "https://example.test/d" },
      { url: "https://example.test/e", time_usec: 13300000000000000 },
      "stray string"
    ]
  });

  it("makes a visit per row: microsecond time, URL and title as content, transition in attrs", async () => {
    const stats = newStats();
    const events = await collect(parseChromeHistory(chunked(file, 11), stats, now));
    expect(events[0]).toMatchObject({
      source: "chrome-takeout",
      kind: "visit",
      start: "2026-01-02T03:04:05.123Z",
      attrs: { transition: "LINK" },
      content: "https://example.test/a\nExample page"
    });
    expect(events[0]!.end).toBeUndefined();
    expect(events[1]!.content).toBe("https://example.test/b");
    expect(JSON.stringify({ ...events[0], content: undefined })).not.toContain("example.test");
  });

  it("keeps two visits at the same microsecond and URL apart with a dup_index, and skips and counts bad rows", async () => {
    const stats = newStats();
    const events = await collect(parseChromeHistory(chunked(file, 11), stats, now));
    expect(events).toHaveLength(4);
    expect(events[2]!.id).not.toBe(events[3]!.id);
    expect(events[2]!.attrs).toEqual({ transition: "LINK" });
    expect(events[3]!.attrs).toEqual({ transition: "LINK", dup_index: 1 });
    expect(stats).toMatchObject({ read: 7, emitted: 4, skipped: 3 });
    expect(Object.keys(stats.reasons)).toEqual([
      "url is missing",
      "time_usec is missing or not a number",
      "time_usec is outside 1995 to tomorrow (expected microseconds since 1970)"
    ]);
  });

  it("gives the same keys on a second read, whatever the chunking", async () => {
    const keys = async (size: number) =>
      (await collect(parseChromeHistory(chunked(file, size), newStats(), now))).map((e) => e.id);
    expect(await keys(3)).toEqual(await keys(500));
    expect(new Set(await keys(3)).size).toBe(4);
  });
});

describe("Google My Activity", () => {
  const file = JSON.stringify([
    { header: "Search", title: "Searched for best  pasta", time: "2026-02-03T04:05:06.789Z", products: ["Search"] },
    {
      header: "Search",
      title: "Visited https://example.test/page",
      titleUrl: "https://example.test/page",
      time: "2026-02-03T04:06:00Z"
    },
    { header: "Gemini Apps", title: "Prompted write a haiku", time: "2026-02-03T04:07:00Z" },
    { header: "Search", title: "Used Search", time: "2026-02-03T04:08:00Z" },
    { header: "Search", title: "Searched for ", time: "2026-02-03T04:09:00Z" },
    { header: "Search", title: "Searched for no zone", time: "2026-02-03T04:10:00" },
    { header: "Search", title: "Searched for twice", time: "2026-02-03T04:11:00Z" },
    { header: "Search", title: "Searched for twice", time: "2026-02-03T04:11:00Z" }
  ]);

  it("strips the verb, maps it to a kind, and puts the text in content only", async () => {
    const stats = newStats();
    const events = await collect(parseGoogleActivity(chunked(file, 13), "Search", stats));
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["search", "best pasta"],
      ["view", "https://example.test/page"],
      ["ask", "write a haiku"],
      ["search", "twice"],
      ["search", "twice"]
    ]);
    expect(events[0]).toMatchObject({
      source: "google-activity",
      start: "2026-02-03T04:05:06.789Z",
      attrs: { product: "Search" }
    });
    expect(JSON.stringify(events[0]!.attrs)).not.toContain("pasta");
    expect(events[3]!.id).not.toBe(events[4]!.id);
  });

  it("reads a verb followed by a non-breaking space", async () => {
    const one = JSON.stringify([{ title: "Searched\u00a0for\u00a0tea", time: "2026-02-03T04:05:06Z" }]);
    const [event] = await collect(parseGoogleActivity(chunked(one), "Search", newStats()));
    expect(event).toMatchObject({ kind: "search", content: "tea" });
  });

  it("tallies the first word of titles it skips, so the summary can name the commonest", async () => {
    const stats = newStats();
    await collect(parseGoogleActivity(chunked(file, 13), "Search", stats));
    expect(stats.verbs).toEqual({ Used: 1 });
  });

  it("skips and counts titles with an unknown verb, an empty remainder or a time without a zone", async () => {
    const stats = newStats();
    await collect(parseGoogleActivity(chunked(file, 13), "Search", stats));
    expect(stats).toMatchObject({ read: 8, emitted: 5, skipped: 3 });
    expect(stats.reasons).toEqual({
      "title starts with a verb this importer does not know": 1,
      "nothing follows the verb in the title": 1,
      "time is missing or has no time zone": 1
    });
  });

  it("leaves YouTube folders to the watch-history route", async () => {
    const stats = newStats();
    expect(await collect(parseGoogleActivity(chunked(file, 50), "YouTube", stats))).toEqual([]);
    expect(stats).toMatchObject({ read: 0, ignored: 8 });
  });

  it("keys on the product, so the same text in two products is two events", async () => {
    const one = '[{"title":"Searched for x","time":"2026-02-03T04:05:06Z"}]';
    const a = await collect(parseGoogleActivity(chunked(one), "Search", newStats()));
    const b = await collect(parseGoogleActivity(chunked(one), "Maps", newStats()));
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });
});

describe("Maps places", () => {
  const file = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        geometry: { coordinates: [151.2093001, -33.8688002], type: "Point" },
        properties: {
          date: "2026-03-04T05:06:07Z",
          Title: "Cafe  One",
          "Google Maps URL": "https://maps.example/1",
          Location: { Address: "1 Test St" }
        }
      },
      {
        geometry: { coordinates: [0, 0] },
        properties: {
          date: "2026-03-05T05:06:07Z",
          Location: { "Business Name": "Nowhere Inc", "Geo Coordinates": { Latitude: "0", Longitude: "0" } }
        }
      },
      { geometry: { coordinates: [1, 2] }, properties: { Title: "No date" } },
      { properties: { date: "2026-03-06T00:00:00Z" } },
      null
    ]
  });

  it("emits instant places with the name and rounded position in attrs", async () => {
    const stats = newStats();
    const events = await collect(parseMapsPlaces(chunked(file, 17), "saved", stats));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "maps-places",
      kind: "place",
      start: "2026-03-04T05:06:07.000Z",
      attrs: { name: "Cafe One", list: "saved", lat: -33.8688, lng: 151.2093 }
    });
    expect(events[0]!.end).toBeUndefined();
    expect(events[1]!.attrs).toEqual({ name: "Nowhere Inc", list: "saved" });
  });

  it("skips and counts a place with no date, no name, or no properties, and never uses the import time", async () => {
    const stats = newStats();
    await collect(parseMapsPlaces(chunked(file, 17), "labelled", stats));
    expect(stats).toMatchObject({ read: 5, emitted: 2, skipped: 3 });
    expect(stats.reasons["place has no date, so it has no time to be placed at"]).toBe(1);
  });

  it("reads a lowercase location object as a fallback", async () => {
    const one = JSON.stringify({
      features: [
        {
          properties: {
            date: "2026-03-04T05:06:07Z",
            location: { "Business Name": "Shop", "Geo Coordinates": { Latitude: "1.5", Longitude: "2.5" } }
          }
        }
      ]
    });
    const [event] = await collect(parseMapsPlaces(chunked(one), "saved", newStats()));
    expect(event!.attrs).toEqual({ name: "Shop", list: "saved", lat: 1.5, lng: 2.5 });
  });

  it("counts a file that is not JSON or has no features as one skipped file", async () => {
    const bad = newStats();
    expect(await collect(parseMapsPlaces(chunked("not json"), "saved", bad))).toEqual([]);
    expect(bad.skipped).toBe(1);
    const none = newStats();
    await collect(parseMapsPlaces(chunked("{}"), "saved", none));
    expect(none.reasons).toEqual({ 'file has no "features" list': 1 });
  });
});

describe("Fit daily metrics", () => {
  const interval = [
    "Start time,End time,Move Minutes count,Step count",
    "00:00:00.000+11:00,00:15:00.000+11:00,0,",
    "00:15:00.000+11:00,00:30:00.000+11:00,3,120",
    "00:30:00.000+11:00,00:45:00.000+11:00,1,0",
    "00:45:00.000+11:00,01:00:00.000+11:00,1,abc",
    "01:00:00,01:15:00,1,5",
    ""
  ].join("\n");

  it("reads interval rows into steps events with the offset, the date coming from the file name", async () => {
    const stats = newStats();
    const events = await collect(parseFitMetrics(chunked(interval, 9), "2026-01-02.csv", stats));
    expect(events).toEqual([
      {
        id: expect.any(String),
        source: "fit",
        kind: "steps",
        start: "2026-01-01T13:15:00.000Z",
        end: "2026-01-01T13:30:00.000Z",
        tzOffsetMin: 660,
        attrs: { steps: 120 }
      }
    ]);
    expect(stats).toMatchObject({ read: 3, emitted: 1, skipped: 2, ignored: 2 });
    expect(stats.reasons).toEqual({
      "step count is not a whole number": 1,
      "start or end time is missing, has no offset, or ends before it starts": 1
    });
  });

  it("reads a summary file by its Date column and marks the day approximate", async () => {
    const stats = newStats();
    const events = await collect(
      parseFitMetrics(
        chunked("Date,Step count\n2026-01-02,8000\n2026-13-45,5\n", 5),
        "Daily activity metrics.csv",
        stats
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      start: "2026-01-02T00:00:00.000Z",
      end: "2026-01-03T00:00:00.000Z",
      approximate: true,
      attrs: { steps: 8000, granularity: "day", date: "2026-01-02" }
    });
    expect(events[0]!.tzOffsetMin).toBeUndefined();
    expect(stats.skipped).toBe(1);
  });

  it("ends an interval that runs to midnight on the next day", async () => {
    const csv = "Start time,End time,Step count\n23:45:00.000+11:00,00:00:00.000+11:00,40\n";
    const [event] = await collect(parseFitMetrics(chunked(csv), "2026-01-02.csv", newStats()));
    expect(event).toMatchObject({ start: "2026-01-02T12:45:00.000Z", end: "2026-01-02T13:00:00.000Z" });
    const stats = newStats();
    await collect(
      parseFitMetrics(
        chunked("Start time,End time,Step count\n10:00:00.000+11:00,09:00:00.000+11:00,4\n"),
        "2026-01-02.csv",
        stats
      )
    );
    expect(stats.skipped).toBe(1);
  });

  it("skips a file without a Step count column, and an interval file with no date in its name", async () => {
    const stats = newStats();
    expect(await collect(parseFitMetrics(chunked("a,b\n1,2\n"), "x.csv", stats))).toEqual([]);
    expect(stats.reasons).toEqual({ 'file has no "Step count" column': 1 });
    const undated = newStats();
    await collect(parseFitMetrics(chunked(interval), "metrics.csv", undated));
    expect(undated.reasons["row has neither a Date column nor Start/End times with the date in the file name"]).toBe(2);
  });
});

describe("Spotify extended history", () => {
  const rows = [
    {
      ts: "2026-04-05T06:07:08Z",
      ms_played: 180000,
      spotify_track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
      master_metadata_track_name: "Song",
      master_metadata_album_artist_name: "Artist",
      master_metadata_album_album_name: "Album",
      skipped: false,
      shuffle: true,
      offline: false,
      reason_start: "trackdone",
      reason_end: "trackdone",
      conn_country: "AU",
      ip_addr: "203.0.113.9",
      platform: "Android OS 12 (Test, X1)"
    },
    {
      ts: "2026-04-05T06:10:08.250Z",
      ms_played: 3000,
      spotify_track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
      master_metadata_track_name: "Song",
      skipped: true,
      reason_end: "fwdbtn"
    },
    {
      ts: "2026-04-05T07:00:00Z",
      ms_played: 600000,
      spotify_episode_uri: "spotify:episode:512ojhOuo1ktJprKbVcKyQ",
      episode_name: "Ep 1",
      episode_show_name: "Show"
    },
    { ts: "2026-04-05T08:00:00Z", ms_played: 1000, spotify_track_uri: null, spotify_episode_uri: null },
    { ts: "2026-04-05T08:00:00Z", ms_played: -5, spotify_track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" },
    { ts: "bad", ms_played: 5, spotify_track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }
  ];
  const file = JSON.stringify(rows);

  it("treats ts as the END of the play: the start is ts minus ms_played; names go in content; nothing identifying is kept", async () => {
    const stats = newStats();
    const events = await collect(parseSpotifyHistory(chunked(file, 29), stats));
    expect(events[0]).toEqual({
      id: "spotify:4uLU6hMCjMI75M1A2tKUQC:2026-04-05T06:07:08Z",
      source: "spotify",
      kind: "play",
      start: "2026-04-05T06:04:08.000Z",
      end: "2026-04-05T06:07:08.000Z",
      attrs: {
        track_id: "4uLU6hMCjMI75M1A2tKUQC",
        ms_played: 180000,
        skipped: false,
        shuffle: true,
        offline: false,
        reason_start: "trackdone",
        reason_end: "trackdone"
      },
      content: "Song\nArtist\nAlbum"
    });
    expect(JSON.stringify(events)).not.toMatch(/203\.0\.113|Android|"AU"/);
    expect(events[1]).toMatchObject({
      id: "spotify:4uLU6hMCjMI75M1A2tKUQC:2026-04-05T06:10:08Z",
      start: "2026-04-05T06:10:05.250Z",
      attrs: { skipped: true }
    });
    expect(events[2]).toMatchObject({
      attrs: { episode_id: "512ojhOuo1ktJprKbVcKyQ", ms_played: 600000 },
      content: "Ep 1\nShow"
    });
  });

  it("skips and counts rows with no id, a negative play length or a bad time", async () => {
    const stats = newStats();
    await collect(parseSpotifyHistory(chunked(file, 29), stats));
    expect(stats).toMatchObject({ read: 6, emitted: 3, skipped: 3 });
  });

  it("keys the same play identically in two exports, so a re-import adds nothing", async () => {
    const a = await collect(parseSpotifyHistory(chunked(file, 3), newStats()));
    const b = await collect(parseSpotifyHistory(chunked(file, 1000), newStats()));
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});

describe("Discord data package", () => {
  const csv = [
    "ID,Timestamp,Contents,Attachments",
    '1100000000000000001,2026-01-02 03:04:05.123456+00:00,"hi, there\nsecond line",',
    "1100000000000000002,2026-01-02 03:05:00+00:00,,https://cdn.example/x.png",
    "abc,2026-01-02 03:05:00+00:00,bad id,",
    "1100000000000000004,not a time,x,",
    ""
  ].join("\r\n");

  it("makes a message per row with the channel id as thread_id and the text in content only", async () => {
    const stats = newStats();
    const events = await collect(parseDiscordMessagesCsv(chunked(csv, 10), "2200000000000000001", stats));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "discord-package",
      kind: "message",
      start: "2026-01-02T03:04:05.123Z",
      attrs: {
        thread_id: "2200000000000000001",
        message_id: "1100000000000000001",
        from_self: true,
        direction: "out",
        has_attachments: false
      },
      content: "hi, there\nsecond line"
    });
    expect(events[0]!.tzOffsetMin).toBeUndefined();
    expect(events[1]!.content).toBeUndefined();
    expect(events[1]!.attrs.has_attachments).toBe(true);
    expect(JSON.stringify(events)).not.toContain("cdn.example");
    expect(stats).toMatchObject({ read: 4, emitted: 2, skipped: 2 });
  });

  it("reads messages.json to the same events and keys as messages.csv", async () => {
    const json = JSON.stringify([
      {
        ID: "1100000000000000001",
        Timestamp: "2026-01-02 03:04:05.123456+00:00",
        Contents: "hi, there\nsecond line",
        Attachments: ""
      },
      {
        ID: "1100000000000000002",
        Timestamp: "2026-01-02 03:05:00+00:00",
        Contents: "",
        Attachments: "https://cdn.example/x.png"
      },
      { ID: 7, Timestamp: "2026-01-02 03:05:00+00:00", Contents: "short id" }
    ]);
    const stats = newStats();
    const fromJson = await collect(parseDiscordMessagesJson(chunked(json, 8), "2200000000000000001", stats));
    const fromCsv = await collect(parseDiscordMessagesCsv(chunked(csv, 8), "2200000000000000001", newStats()));
    expect(fromJson.map((e) => e.id)).toEqual(fromCsv.map((e) => e.id));
    expect(fromJson.slice(0, 2)).toEqual(fromCsv);
    expect(stats.skipped).toBe(1);
  });

  it("skips a record with an oversized field and keeps the next", async () => {
    const stats = newStats();
    const huge = "y".repeat(1_100_000);
    const events = await collect(
      parseDiscordMessagesCsv(
        chunked(
          `ID,Timestamp,Contents\n1100000000000000001,2026-01-02 03:04:05+00:00,${huge}\n1100000000000000002,2026-01-02 03:04:06+00:00,ok\n`,
          200_000
        ),
        "2200000000000000001",
        stats
      )
    );
    expect(events.map((e) => e.content)).toEqual(["ok"]);
    expect(stats.reasons).toEqual({ "a field is larger than 1 MB": 1 });
  });

  it("skips a csv whose header lacks the id and timestamp columns", async () => {
    const stats = newStats();
    expect(await collect(parseDiscordMessagesCsv(chunked("a,b\n1,2\n"), "2200000000000000001", stats))).toEqual([]);
    expect(stats.reasons).toEqual({ "messages.csv header has no ID and Timestamp columns": 1 });
  });

  it("takes the channel id from a package folder name", () => {
    expect(channelIdFromFolder("c2200000000000000001")).toBe("2200000000000000001");
    expect(channelIdFromFolder("2200000000000000001")).toBe("2200000000000000001");
    expect(channelIdFromFolder("index")).toBeNull();
  });
});

describe("Apple Health export.xml", () => {
  const rec = (type: string, source: string, start: string, end: string, value: string) =>
    `<Record type="${type}" sourceName="${source}" sourceVersion="1" unit="count" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`;
  const STEP = "HKQuantityTypeIdentifierStepCount";
  const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_AU">
 <ExportDate value="2026-05-06 07:08:09 +1000"/>
 ${rec(STEP, "Test Phone", "2026-05-06 08:10:00 +1000", "2026-05-06 08:20:00 +1000", "100")}
 ${rec(STEP, "Test Phone", "2026-05-06 08:50:00 +1000", "2026-05-06 08:55:00 +1000", "50")}
 ${rec(STEP, "Test Watch", "2026-05-06 08:30:00 +1000", "2026-05-06 08:31:00 +1000", "20")}
 ${rec(STEP, "Test Phone", "2026-05-06 09:00:00 +1000", "2026-05-06 09:10:00 +1000", "7")}
 ${rec(STEP, "Test Phone", "2026-05-06 09:00:00 +1000", "2026-05-06 09:10:00 +1000", "-3")}
 ${rec(STEP, "Test Phone", "garbage", "garbage", "3")}
 ${rec(SLEEP, "Test Watch", "2026-05-05 23:00:00 +1000", "2026-05-06 01:00:00 +1000", "HKCategoryValueSleepAnalysisAsleepDeep")}
 ${rec(SLEEP, "Test Phone", "2026-05-05 22:30:00 +1000", "2026-05-06 06:30:00 +1000", "HKCategoryValueSleepAnalysisInBed")}
 ${rec(SLEEP, "Test Watch", "2026-05-05 22:30:00 +1000", "2026-05-06 06:30:00 +1000", "HKCategoryValueSleepAnalysisMystery")}
 ${rec("HKQuantityTypeIdentifierHeartRate", "Test Watch", "2026-05-06 08:30:00 +1000", "2026-05-06 08:30:00 +1000", "61")}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" totalEnergyBurned="320" totalEnergyBurnedUnit="kcal" sourceName="Test Watch" startDate="2026-05-06 06:00:00 +1000" endDate="2026-05-06 06:30:30 +1000">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeYoga" sourceName="Test Watch" startDate="2026-05-06 18:00:00 +0530" endDate="2026-05-06 17:00:00 +0530"/>
</HealthData>`;

  it("sums steps into hourly buckets per source device, keyed by device and hour, with the local offset", async () => {
    const stats = newStats();
    const events = await collect(parseAppleHealth(chunked(xml, 41), stats));
    const steps = events.filter((e) => e.kind === "steps");
    // The newest bucket of each device (Phone 23:00, Watch 22:00) may be partial in a mid-hour export, so it is held back.
    expect(steps.map((e) => [e.attrs.source_name, e.start, e.attrs.steps])).toEqual([
      ["Test Phone", "2026-05-05T22:00:00.000Z", 150]
    ]);
    expect(steps[0]).toMatchObject({ end: "2026-05-05T23:00:00.000Z", tzOffsetMin: 600, attrs: { records: 2 } });
    expect(stats.ignored).toBeGreaterThanOrEqual(2);
  });

  it("emits sleep stages per device and workouts with their facts, and ignores other record types", async () => {
    const stats = newStats();
    const events = await collect(parseAppleHealth(chunked(xml, 41), stats));
    const sleep = events.filter((e) => e.kind === "sleep");
    expect(sleep.map((e) => [e.attrs.source_name, e.attrs.stage])).toEqual([
      ["Test Watch", "deep"],
      ["Test Phone", "in_bed"]
    ]);
    expect(sleep[0]).toMatchObject({
      start: "2026-05-05T13:00:00.000Z",
      end: "2026-05-05T15:00:00.000Z",
      tzOffsetMin: 600
    });
    const workout = events.find((e) => e.kind === "workout")!;
    expect(workout).toMatchObject({
      start: "2026-05-05T20:00:00.000Z",
      end: "2026-05-05T20:30:30.000Z",
      attrs: {
        activity_type: "Running",
        duration_min: 30.5,
        distance: 5.2,
        distance_unit: "km",
        energy: 320,
        energy_unit: "kcal",
        source_name: "Test Watch"
      }
    });
    expect(stats.ignored).toBe(3); // the heart-rate record and the two held-back newest step buckets
  });

  it("skips and counts unreadable dates, negative steps, unknown sleep stages and reversed workouts", async () => {
    const stats = newStats();
    await collect(parseAppleHealth(chunked(xml, 41), stats));
    expect(stats.reasons).toEqual({
      "step record has a missing or negative value": 1,
      "step record has an unreadable startDate": 1,
      "sleep record has a stage this importer does not know": 1,
      "workout has an unreadable or reversed startDate and endDate": 1
    });
  });

  it("gives the same keys on a second read, and the per-device rows never share a key", async () => {
    const keys = async (size: number) =>
      (await collect(parseAppleHealth(chunked(xml, size), newStats()))).map((e) => e.id);
    expect(await keys(5)).toEqual(await keys(5000));
    expect(new Set(await keys(5)).size).toBe((await keys(5)).length);
    // The held-back bucket is emitted by a later export that goes past it, under the same key a full run would give.
    const later = xml.replace(
      "</HealthData>",
      `${rec(STEP, "Test Phone", "2026-05-06 12:00:00 +1000", "2026-05-06 12:05:00 +1000", "9")}</HealthData>`
    );
    const phone2300 = (await collect(parseAppleHealth(chunked(later, 99), newStats()))).find(
      (e) => e.start === "2026-05-05T23:00:00.000Z"
    );
    expect(phone2300?.attrs.steps).toBe(7);
  });

  it("buckets by the local wall-clock hour even for a half-hour offset", async () => {
    const half = `<HealthData>${rec(STEP, "Test Phone", "2026-05-06 10:20:00 +0530", "2026-05-06 10:25:00 +0530", "9")}${rec(STEP, "Test Phone", "2026-05-06 12:20:00 +0530", "2026-05-06 12:25:00 +0530", "1")}</HealthData>`;
    const [bucket] = await collect(parseAppleHealth(chunked(half), newStats()));
    expect(bucket).toMatchObject({ start: "2026-05-06T04:30:00.000Z", tzOffsetMin: 330 });
  });

  it("reads Apple dates and rejects impossible ones", () => {
    expect(parseAppleDate("2026-05-06 08:10:00 +1000")).toEqual({ ms: Date.UTC(2026, 4, 5, 22, 10), offsetMin: 600 });
    expect(parseAppleDate("2026-02-30 08:10:00 +1000")).toBeNull();
    expect(parseAppleDate("2026-05-06T08:10:00+1000")).toBeNull();
    expect(parseAppleDate(undefined)).toBeNull();
  });

  it("holds back the last hourly bucket per device when the file was cut off", async () => {
    const cut = xml.slice(0, xml.indexOf("<Workout"));
    const stats = newStats();
    const events = await collect(
      parseAppleHealth(chunked(cut + '<Record type="x" sourceName="a" startDate="2026', 50), stats)
    );
    expect(stats.truncated).toBe(true);
    expect(events.filter((e) => e.kind === "steps").map((e) => [e.attrs.source_name, e.start])).toEqual([
      ["Test Phone", "2026-05-05T22:00:00.000Z"]
    ]);
  });

  it("flags a truncated file and still emits what it read", async () => {
    const stats = newStats();
    const events = await collect(parseAppleHealth(chunked(xml.slice(0, xml.indexOf("<Workout") + 30), 50), stats));
    expect(stats.truncated).toBe(true);
    expect(events.some((e) => e.kind === "steps")).toBe(true);
  });
});

describe("every parser", () => {
  it("emits only fields the ingest contract takes, with ids within its limit", async () => {
    const stats = newStats();
    const events = await collect(
      parseSpotifyHistory(
        chunked(
          '[{"ts":"2026-04-05T06:07:08Z","ms_played":1,"spotify_track_uri":"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}]'
        ),
        stats
      )
    );
    for (const event of events) {
      expect(
        Object.keys(event).every((key) =>
          ["id", "source", "kind", "start", "end", "tzOffsetMin", "approximate", "attrs", "content"].includes(key)
        )
      ).toBe(true);
      expect(event.id.length).toBeLessThanOrEqual(200);
    }
  });
});
