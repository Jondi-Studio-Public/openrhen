import { afterEach, describe, expect, it } from "vitest";
import { bundledConnections } from "./bundled-connections.js";
import { fakeManifest } from "./fake-connection.js";
import type { BoundConnection } from "./connection-api.js";
import {
  assertSupportedManifestVersion,
  connectionStatuses,
  loadConnections,
  secretReadiness,
  setConnectionHostForTests
} from "./connection-host.js";
import { calendarFeedConnection } from "../connections/calendar-feed/connection.js";

afterEach(() => setConnectionHostForTests(undefined));

describe("loadConnections", () => {
  const working: BoundConnection = {
    manifest: fakeManifest("working_conn"),
    create: () => ({ travel_time: { matrix: { kind: "json", run: async () => ({ status: 200, body: {} }) } } })
  };
  const broken: BoundConnection = {
    manifest: fakeManifest("broken_conn"),
    create: () => {
      throw new Error("bad config");
    }
  };

  it("keeps a throwing create isolated and marks it failed", () => {
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const loaded = loadConnections([broken, working], { FAKE_KEY: "k" });
      expect(loaded.map((entry) => [entry.bound.manifest.id, entry.failed, entry.impl !== undefined])).toEqual([
        ["broken_conn", true, false],
        ["working_conn", false, true]
      ]);
      expect(loaded[0]!.ready).toBe(false);
      expect(loaded[1]!.ready).toBe(true);
      expect(stderr.join("")).toContain("broken_conn");
    } finally {
      process.stderr.write = write;
    }
  });

  it("reports readiness without blocking the connection", () => {
    const [entry] = loadConnections([working], {});
    expect(entry!.ready).toBe(false);
    expect(entry!.missing).toEqual(["FAKE_KEY"]);
    expect(entry!.impl).toBeDefined();
  });

  it("lists statuses with names only", () => {
    setConnectionHostForTests(loadConnections([working], {}));
    expect(connectionStatuses()).toEqual([
      { id: "working_conn", label: "Fake", capabilities: ["travel_time"], ready: false, missing: ["FAKE_KEY"] }
    ]);
  });
});

describe("the calendar feed connection is not ready until its field exists", () => {
  it("reports the URL as missing when unset, blank or the placeholder, and ready once set", () => {
    const groups = calendarFeedConnection.manifest.secrets.anyOf;
    expect(secretReadiness(groups, {})).toEqual({ ready: false, missing: ["CALENDAR_FEED_URL"] });
    expect(secretReadiness(groups, { CALENDAR_FEED_URL: "   " }).ready).toBe(false);
    expect(secretReadiness(groups, { CALENDAR_FEED_URL: "replace-before-lan-use" }).ready).toBe(false);
    expect(secretReadiness(groups, { CALENDAR_FEED_URL: "https://calendar.example.com/a.ics" })).toEqual({
      ready: true,
      missing: []
    });
  });
});

describe("secretReadiness", () => {
  const groups = [["A", "B"], ["C"]];
  it("is ready when one whole group is set", () => {
    expect(secretReadiness(groups, { C: "x" })).toEqual({ ready: true, missing: [] });
  });
  it("treats the compose placeholder as unset and names the closest group's gaps", () => {
    expect(secretReadiness(groups, { A: "x", B: "replace-before-lan-use" })).toEqual({ ready: false, missing: ["B"] });
    expect(secretReadiness([["A", "B"]], { A: "x" })).toEqual({ ready: false, missing: ["B"] });
  });
});

describe("manifest version", () => {
  it("accepts version 1 and a manifest with no version", () => {
    expect(() => assertSupportedManifestVersion(fakeManifest("v_none"))).not.toThrow();
    expect(() => assertSupportedManifestVersion({ ...fakeManifest("v_one"), version: 1 })).not.toThrow();
  });
  it("rejects version 2 with an error naming both versions", () => {
    expect(() => assertSupportedManifestVersion({ ...fakeManifest("v_two"), version: 2 })).toThrow(
      /version 2.*supports.*1|supports.*1.*version 2/
    );
  });
  it("marks a too-new connection failed without stopping the host", () => {
    const tooNew: BoundConnection = { manifest: { ...fakeManifest("too_new"), version: 2 }, create: () => ({}) };
    const write = process.stderr.write.bind(process.stderr);
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const [entry] = loadConnections([tooNew], {});
      expect(entry!.failed).toBe(true);
      expect(entry!.impl).toBeUndefined();
      expect(stderr.join("")).toContain("version 2");
    } finally {
      process.stderr.write = write;
    }
  });
  it("loads every built-in manifest at the supported version", () => {
    for (const connection of bundledConnections())
      expect(() => assertSupportedManifestVersion(connection.manifest)).not.toThrow();
  });
});
