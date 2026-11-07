import { describe, expect, it } from "vitest";
import { chunked, collect } from "./fixtures.js";
import { parseAccessLogCsv, parseAccessLogJson } from "./parsers/access-log.js";
import { chatSpaceId, parseChatDate, parseChatOwner, parseGoogleChatMessages } from "./parsers/google-chat.js";
import { isPhotoSidecarName, parseGooglePhotosSidecar } from "./parsers/google-photos.js";
import { parseTimeline } from "./parsers/timeline.js";
import { newStats } from "./types.js";

const now = new Date("2026-11-07T00:00:00Z");

describe("Timeline: Records.json points", () => {
  const file = JSON.stringify({
    locations: [
      { timestampMs: "1767323045123", latitudeE7: -338688000, longitudeE7: 1512093000, accuracy: 12, source: "WIFI" },
      { timestamp: "2026-01-02T03:04:06.000+11:00", latitudeE7: -338688000, longitudeE7: 1512093000 },
      { timestampMs: "1767323045123", latitudeE7: -338688000, longitudeE7: 1512093000, accuracy: 12, source: "WIFI" },
      { timestampMs: "1767323045", latitudeE7: 1, longitudeE7: 2 },
      { timestampMs: "1767323045123", latitudeE7: 0, longitudeE7: 0 },
      { latitudeE7: 5, longitudeE7: 5 },
      { weird: true }
    ]
  });

  it("makes a point per row with E7 positions, explicit zones kept, duplicates kept apart, and never rescales seconds", async () => {
    const stats = newStats();
    const events = await collect(parseTimeline(chunked(file, 13), stats, now));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      source: "timeline",
      kind: "point",
      start: "2026-01-02T03:04:05.123Z",
      attrs: { lat: -33.8688, lng: 151.2093, accuracy_m: 12, source: "WIFI" }
    });
    expect(events[1]!.tzOffsetMin).toBe(660);
    expect(events[2]!.attrs.dup_index).toBe(1);
    expect(events[2]!.id).not.toBe(events[0]!.id);
    expect(stats).toMatchObject({ read: 7, emitted: 3, skipped: 4 });
    expect(Object.keys(stats.reasons)).toEqual([
      "location point has no time (epoch milliseconds, or text with a time zone)",
      "location point has no usable position",
      "element is not a place visit, activity segment, path or location point"
    ]);
  });

  it("gives the same keys on a second read", async () => {
    const a = await collect(parseTimeline(chunked(file), newStats(), now));
    const b = await collect(parseTimeline(chunked(file, 5), newStats(), now));
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});

describe("Timeline: Semantic Location History", () => {
  const file = JSON.stringify({
    timelineObjects: [
      {
        placeVisit: {
          location: {
            latitudeE7: -338688000,
            longitudeE7: 1512093000,
            placeId: "ChIJabc",
            name: "Cafe  One",
            address: "1 Main St"
          },
          duration: { startTimestamp: "2026-01-02T01:00:00.000Z", endTimestamp: "2026-01-02T02:00:00Z" },
          placeConfidence: "HIGH_CONFIDENCE",
          visitConfidence: 90
        }
      },
      {
        activitySegment: {
          startLocation: { latitudeE7: -338688000, longitudeE7: 1512093000 },
          endLocation: { latitudeE7: -337000000, longitudeE7: 1511000000 },
          duration: { startTimestampMs: "1767323045000", endTimestampMs: "1767324045000" },
          distance: 1234,
          activityType: "IN_PASSENGER_VEHICLE",
          confidence: "HIGH",
          waypointPath: { waypoints: [{ latE7: 1, lngE7: 2 }] }
        }
      },
      { placeVisit: { location: { name: "no place" }, duration: { startTimestamp: "2026-01-02T01:00:00Z" } } },
      { placeVisit: { location: { placeId: "x" }, duration: { startTimestamp: "2026-01-02 01:00:00" } } },
      {
        activitySegment: { duration: { startTimestamp: "2026-01-02T05:00:00Z", endTimestamp: "2026-01-02T04:00:00Z" } }
      }
    ]
  });

  it("makes place visits and activity segments, with name and address as content only", async () => {
    const stats = newStats();
    const events = await collect(parseTimeline(chunked(file, 17), stats, now));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "place_visit",
      start: "2026-01-02T01:00:00.000Z",
      end: "2026-01-02T02:00:00.000Z",
      content: "Cafe One\n1 Main St",
      attrs: {
        lat: -33.8688,
        lng: 151.2093,
        place_id: "ChIJabc",
        place_confidence: "HIGH_CONFIDENCE",
        visit_confidence: 90
      }
    });
    expect(JSON.stringify(events[0]!.attrs)).not.toContain("Cafe");
    expect(events[1]).toMatchObject({
      kind: "activity_segment",
      start: "2026-01-02T03:04:05.000Z",
      end: "2026-01-02T03:20:45.000Z",
      attrs: { activity_type: "IN_PASSENGER_VEHICLE", distance_m: 1234, start_lat: -33.8688, end_lng: 151.1 }
    });
    expect(JSON.stringify(events[1])).not.toContain("waypoint");
    expect(stats).toMatchObject({ read: 5, emitted: 2, skipped: 3 });
    expect(Object.keys(stats.reasons)).toEqual([
      "place visit has neither a position nor a place id",
      "place visit has no start time with a time zone (or epoch milliseconds)",
      "activity segment ends before it starts"
    ]);
  });
});

describe("Timeline: on-device Timeline.json", () => {
  const segments = [
    {
      startTime: "2026-01-02T10:00:00.000+11:00",
      endTime: "2026-01-02T11:00:00.000+11:00",
      visit: {
        probability: 0.9,
        topCandidate: { placeId: "P1", semanticType: "HOME", placeLocation: { latLng: "-33.8688°, 151.2093°" } }
      }
    },
    {
      startTime: "2026-01-02T11:00:00.000+11:00",
      endTime: "2026-01-02T11:30:00.000+11:00",
      activity: {
        start: { latLng: "-33.8688°, 151.2093°" },
        end: { latLng: "-33.9°, 151.3°" },
        distanceMeters: "5000.5",
        topCandidate: { type: "cycling", probability: 0.8 }
      }
    },
    {
      startTime: "2026-01-02T11:00:00.000+11:00",
      endTime: "2026-01-02T11:30:00.000+11:00",
      timelinePath: [
        { point: "-33.87°, 151.21°", durationMinutesOffsetFromStartTime: "5" },
        { point: "-33.88°, 151.22°", time: "2026-01-02T11:10:00.000+11:00" },
        { point: "not a point", time: "2026-01-02T11:10:00.000+11:00" },
        { point: "-33.88°, 151.22°" }
      ]
    }
  ];

  it("reads a bare array and a semanticSegments object alike", async () => {
    for (const text of [
      JSON.stringify(segments),
      JSON.stringify({ semanticSegments: segments, rawSignals: [{ a: 1 }] })
    ]) {
      const stats = newStats();
      const events = await collect(parseTimeline(chunked(text, 23), stats, now));
      expect(events.map((e) => e.kind)).toEqual(["place_visit", "activity_segment", "point", "point"]);
      expect(events[0]).toMatchObject({
        tzOffsetMin: 660,
        attrs: { place_id: "P1", semantic_type: "HOME", lat: -33.8688 }
      });
      expect(events[1]!.attrs).toMatchObject({ activity_type: "cycling", distance_m: 5001, confidence: 0.8 });
      expect(events[2]!.start).toBe("2026-01-02T00:05:00.000Z");
      expect(stats).toMatchObject({ emitted: 4, skipped: 2 });
    }
  });

  it("flags a cut-off file but keeps what was read", async () => {
    const stats = newStats();
    const text = JSON.stringify(segments).slice(0, 400);
    const events = await collect(parseTimeline(chunked(text, 9), stats, now));
    expect(stats.truncated).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Google Chat", () => {
  const messages = JSON.stringify({
    messages: [
      {
        creator: { name: "Me", email: "Me@example.test", user_type: "Human" },
        created_date: "Monday, January 2, 2023 at 3:04:05 PM UTC",
        message_id: "AAA/m1",
        topic_id: "t1",
        text: "hello there"
      },
      {
        creator: { name: "Pal", email: "pal@example.test", user_type: "Human" },
        created_date: "Tuesday, 3 January 2023 at 01:02:03 UTC",
        message_id: "AAA/m2",
        attached_files: [{ export_name: "x.png" }],
        annotations: [{ url_metadata: { url: "https://secret.test" } }]
      },
      {
        creator: { email: "pal@example.test" },
        created_date: "Tuesday, 3 January 2023 at 01:02:03 PST",
        message_id: "AAA/m3",
        text: "x"
      },
      {
        creator: { email: "pal@example.test" },
        created_date: "mardi 3 janvier 2023 à 01:02:03 UTC",
        message_id: "AAA/m4",
        text: "x"
      },
      { created_date: "Tuesday, January 3, 2023 at 1:02:03 AM UTC", text: "no id" },
      { created_date: "Tuesday, February 31, 2023 at 1:02:03 AM UTC", message_id: "AAA/m6" }
    ]
  });

  it("makes a message per row, marks the owner's own, keeps text only as content and never guesses a time", async () => {
    const stats = newStats();
    const events = await collect(parseGoogleChatMessages(chunked(messages, 19), "AAA", "me@example.test", stats, now));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "google-chat",
      kind: "message",
      start: "2023-01-02T15:04:05.000Z",
      content: "hello there",
      attrs: {
        thread_id: "AAA",
        message_id: "AAA/m1",
        from: "me@example.test",
        from_self: true,
        direction: "out",
        topic_id: "t1",
        has_attachments: false
      }
    });
    expect(events[1]!.attrs).toMatchObject({ from_self: false, direction: "in", has_attachments: true });
    expect(events[1]!.content).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("secret.test");
    expect(stats).toMatchObject({ read: 6, emitted: 2, skipped: 4 });
  });

  it("leaves from_self out when the owner is unknown", async () => {
    const events = await collect(parseGoogleChatMessages(chunked(messages), "AAA", null, newStats(), now));
    expect(events[0]!.attrs).not.toHaveProperty("from_self");
    expect(events[0]!.attrs).not.toHaveProperty("direction");
  });

  it("parses the two date forms, the owner file and the space folder name", async () => {
    expect(parseChatDate("Monday, January 2, 2023 at 12:00:00 AM UTC", now)?.toISOString()).toBe(
      "2023-01-02T00:00:00.000Z"
    );
    expect(parseChatDate("Monday, January 2, 2023 at 12:00:00 PM UTC", now)?.toISOString()).toBe(
      "2023-01-02T12:00:00.000Z"
    );
    expect(parseChatDate("Monday, January 2, 2023 at 13:00:00 PM UTC", now)).toBeNull();
    expect(parseChatDate("2023-01-02T00:00:00Z", now)).toBeNull();
    expect(await parseChatOwner(chunked(JSON.stringify({ user: { email: "A@B.test" } })))).toBe("a@b.test");
    expect(await parseChatOwner(chunked("not json"))).toBeNull();
    expect(chatSpaceId("Space AAAAjyXr")).toBe("AAAAjyXr");
    expect(chatSpaceId("DM L1x-AAAA")).toBe("L1x-AAAA");
  });
});

describe("Access Log Activity", () => {
  const csv = [
    "Activity Timestamp,Activity Type,Product Name,User Agent String,IP Address",
    '2026-01-02 03:04:05 UTC,Login,Gmail,"Mozilla/5.0 (X11)",203.0.113.9',
    "2026-01-02 03:04:05 UTC,Login,Gmail,curl/8,198.51.100.2",
    "2026-01-02T05:06:07+11:00,Access,Drive,x,y",
    "Jan 2 2026,Access,Drive,x,y",
    "2026-01-02 03:04:05 UTC,,,x,y"
  ].join("\n");

  it("makes an access per row from product and type only, and never reads the IP or user agent", async () => {
    const stats = newStats();
    const events = await collect(parseAccessLogCsv(chunked(csv, 13), stats, now));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      source: "google-access-log",
      kind: "access",
      start: "2026-01-02T03:04:05.000Z",
      attrs: { product: "Gmail", activity_type: "Login" }
    });
    expect(events[1]!.attrs.dup_index).toBe(1);
    expect(events[2]!.start).toBe("2026-01-01T18:06:07.000Z");
    const all = JSON.stringify(events);
    for (const secret of ["203.0.113", "198.51.100", "Mozilla", "curl"]) expect(all).not.toContain(secret);
    expect(events.every((e) => e.content === undefined)).toBe(true);
    expect(stats).toMatchObject({ read: 5, emitted: 3, skipped: 2 });
  });

  it("reads a JSON form and refuses a header with no timestamp", async () => {
    const stats = newStats();
    const json = JSON.stringify([
      { "Activity Timestamp": "2026-01-02 03:04:05 UTC", "Product Name": "Maps", "IP Address": "1.2.3.4" }
    ]);
    const events = await collect(parseAccessLogJson(chunked(json), stats, now));
    expect(events[0]!.attrs).toEqual({ product: "Maps" });
    expect(JSON.stringify(events)).not.toContain("1.2.3.4");
    const bad = newStats();
    expect(await collect(parseAccessLogCsv(chunked("a,b\n1,2\n"), bad, now))).toHaveLength(0);
    expect(bad.reasons).toEqual({ "header has no timestamp column": 1 });
  });
});

describe("Google Photos sidecars", () => {
  const sidecar = JSON.stringify({
    title: "IMG_1234.jpg",
    description: "At the beach",
    imageViews: "3",
    creationTime: { timestamp: "1767400000", formatted: "whatever" },
    photoTakenTime: { timestamp: "1767323045", formatted: "Jan 2, 2026, 3:04:05 AM UTC" },
    geoData: { latitude: -33.8688, longitude: 151.2093, altitude: 10 },
    url: "https://photos.google.com/photo/xyz"
  });

  it("makes one event per item at photoTakenTime, with the kind from the media extension and the key from stable fields", async () => {
    const stats = newStats();
    const [photo] = await collect(
      parseGooglePhotosSidecar(chunked(sidecar, 11), "IMG_1234.jpg.supplemental-metadata.json", stats, now)
    );
    expect(photo).toMatchObject({
      source: "google-photos",
      kind: "photo",
      start: "2026-01-02T03:04:05.000Z",
      content: "IMG_1234.jpg\nAt the beach",
      attrs: { lat: -33.8688, lng: 151.2093, uploaded_at: "2026-01-03T00:26:40.000Z" }
    });
    expect(JSON.stringify(photo!.attrs)).not.toContain("beach");
    expect(JSON.stringify(photo)).not.toContain("photos.google.com");
    const [again] = await collect(parseGooglePhotosSidecar(chunked(sidecar, 3), "IMG_1234.jpg.json", newStats(), now));
    expect(again!.id).toBe(photo!.id);
    const [video] = await collect(parseGooglePhotosSidecar(chunked(sidecar), "MOV_1.mp4.json", newStats(), now));
    expect(video!.kind).toBe("video");
    expect(stats).toMatchObject({ read: 1, emitted: 1 });
  });

  it("skips and counts a sidecar with no usable taken time, with millisecond values, or that is not JSON; 0,0 is no position", async () => {
    const run = async (text: string, name = "a.jpg.json") => {
      const stats = newStats();
      const events = await collect(parseGooglePhotosSidecar(chunked(text), name, stats, now));
      return { events, stats };
    };
    expect((await run(JSON.stringify({ creationTime: { timestamp: "1767400000" } }))).stats.skipped).toBe(1);
    expect((await run(JSON.stringify({ photoTakenTime: { timestamp: "1767323045000" } }))).stats.skipped).toBe(1);
    expect((await run("{nope")).stats.skipped).toBe(1);
    expect((await run("[]")).stats.skipped).toBe(1);
    expect((await run("{}", "notes.txt.json")).stats.skipped).toBe(1);
    const zero = await run(
      JSON.stringify({ photoTakenTime: { timestamp: "1767323045" }, geoData: { latitude: 0, longitude: 0 } })
    );
    expect(zero.events[0]!.attrs).toEqual({});
  });

  it("recognises sidecar names and not album metadata", () => {
    for (const name of [
      "a.jpg.json",
      "a.JPEG.json",
      "a.mp4.supplemental-metadata.json",
      "a.jpg.supplemental-metad.json",
      "a.jpg(1).json",
      "a.heic.json"
    ])
      expect(isPhotoSidecarName(name), name).toBe(true);
    for (const name of [
      "metadata.json",
      "print-subscriptions.json",
      "shared_album_comments.json",
      "a.jpg",
      "a.txt.json"
    ])
      expect(isPhotoSidecarName(name), name).toBe(false);
  });
});
