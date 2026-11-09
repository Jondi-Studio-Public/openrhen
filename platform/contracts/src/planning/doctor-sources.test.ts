import { describe, expect, it } from "vitest";
import { emptyDoctorSlices, runDoctor, type DoctorSnapshot } from "./doctor.js";
import {
  DOCTOR_SOURCE_CHECKS,
  sourceCountsLine,
  sourceItems,
  type DoctorSourceInput,
  type DoctorSourcesSlice
} from "./doctor-sources.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const source = (id: string, extra: Partial<DoctorSourceInput> = {}): DoctorSourceInput => ({
  id,
  name: id,
  keepsSyncChecks: false,
  engineReads: false,
  configured: true,
  freshness: "fresh",
  lastSuccessAt: hoursAgo(1),
  threshold: { warnHours: 24, errorHours: 72, from: "default" },
  reachEmpty: false,
  ...extra
});

const slice = (extra: Partial<DoctorSourcesSlice> = {}): DoctorSourcesSlice => ({
  sources: [],
  devices: [],
  issues: [],
  unused: 0,
  nothingSends: 0,
  ...extra
});

const checks = (input: DoctorSourcesSlice) => sourceItems(input, NOW).items.map((item) => item.id);

describe("source_late", () => {
  it("names a source past its warning and says what to do, at the degrading tier", () => {
    const { items } = sourceItems(
      slice({ sources: [source("a", { freshness: "late", lastSuccessAt: hoursAgo(30) })] }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "source_late:a",
      check: "source_late",
      tier: "degrading",
      area: "integrations",
      handles: ["source:a"]
    });
    expect(items[0]!.title).toContain("30 h");
    expect(items[0]!.fix.cli).toBe("rhen sources a");
    expect(items[0]!.why).toContain("24 h");
    expect(items[0]!.fix.question).toContain("`rhen sources a`");
    // The step after the owner triggers it is a command, and it says what to look for.
    expect(items[0]!.fix.question).toContain("`rhen sources --problems`");
    expect(items[0]!.fix.question).not.toMatch(/[<>]/);
  });

  it("is blocking past the error threshold only when the engine reads the source and the threshold is stated", () => {
    const stale = { freshness: "stale", lastSuccessAt: hoursAgo(100) } as const;
    const tier = (input: DoctorSourceInput) => sourceItems(slice({ sources: [input] }), NOW).items[0]!.tier;
    expect(tier(source("a", { ...stale, engineReads: true }))).toBe("blocking");
    expect(tier(source("a", { ...stale, engineReads: false }))).toBe("degrading");
    // Late but not yet stale never blocks, whatever the engine reads.
    expect(tier(source("a", { freshness: "late", lastSuccessAt: hoursAgo(30), engineReads: true }))).toBe("degrading");
  });

  it("keeps a learned threshold at degrading until it rests on 30 days of arrivals", () => {
    const learned = (days: number) =>
      source("a", {
        freshness: "stale",
        lastSuccessAt: hoursAgo(100),
        engineReads: true,
        threshold: { warnHours: 24, errorHours: 72, from: "learned", days }
      });
    const tier = (input: DoctorSourceInput) => sourceItems(slice({ sources: [input] }), NOW).items[0]!.tier;
    expect(tier(learned(12))).toBe("degrading");
    expect(tier(learned(30))).toBe("blocking");
  });

  it("leaves calendar and other sync sources to sync_late and sync_failing", () => {
    expect(
      checks(
        slice({ sources: [source("cal", { keepsSyncChecks: true, freshness: "stale", lastSuccessAt: hoursAgo(99) })] })
      )
    ).toEqual([]);
  });

  it("raises nothing for fresh, n/a, failing or not-set-up sources", () => {
    expect(
      checks(
        slice({
          sources: [
            source("fresh"),
            source("import", { freshness: "n/a", threshold: null }),
            source("failing", { freshness: "failing" }),
            source("unset", { freshness: "never", configured: false, lastSuccessAt: null })
          ]
        })
      )
    ).toEqual([]);
  });

  it("names the one kind that stopped when the source as a whole is still fresh", () => {
    const { items } = sourceItems(
      slice({
        sources: [
          source("a", {
            freshness: "fresh",
            lastSuccessAt: hoursAgo(1),
            lateKinds: [{ kind: "alert", lastAt: hoursAgo(80), warnHours: 30 }]
          })
        ]
      }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.tier).toBe("degrading");
    expect(items[0]!.title).toContain("alert");
  });
});

describe("source_silent", () => {
  it("fires for a never-seen source whose token exists, and not for one that was never set up", () => {
    const silent = source("a", { freshness: "never", configured: false, lastSuccessAt: null, credentialPresent: true });
    const { items } = sourceItems(
      slice({ sources: [silent, source("b", { freshness: "never", configured: false, lastSuccessAt: null })] }),
      NOW
    );
    expect(items.map((item) => item.id)).toEqual(["source_silent:a"]);
    expect(items[0]).toMatchObject({ tier: "degrading", area: "integrations" });
    expect(items[0]!.fix.question).toContain("token");
    expect(items[0]!.fix.question).toContain("`rhen agent-token list`");
  });
});

describe("device_silent", () => {
  const feed = (id: string, hours: number, device = "phone", warn = 24) =>
    source(id, {
      device,
      freshness: hours > warn ? "late" : "fresh",
      lastSuccessAt: hoursAgo(hours),
      threshold: { warnHours: warn, errorHours: null, from: "default" }
    });
  const device = (feeds: string[], hours: number) => ({
    id: "phone",
    entries: feeds,
    lastSeenAt: hoursAgo(hours),
    lastSeenFrom: feeds[0]!
  });

  it("gives one item for a device whose feeds are all late, and drops the per-feed items", () => {
    const { items, counts } = sourceItems(
      slice({ sources: [feed("a", 60), feed("b", 70, "phone", 36)], devices: [device(["a", "b"], 60)] }),
      NOW
    );
    expect(items.map((item) => item.id)).toEqual(["device_silent:phone"]);
    expect(items[0]).toMatchObject({ tier: "degrading", handles: ["device:phone"] });
    expect(items[0]!.title).toContain("phone");
    expect(counts.deviceSilent).toBe(1);
  });

  it("keeps the device item blocking when a folded feed would have been, and names the commands in the text", () => {
    const stale = (id: string) => ({
      ...feed(id, 100, "phone", 24),
      freshness: "stale" as const,
      engineReads: id === "a",
      threshold: { warnHours: 24, errorHours: 72, from: "default" }
    });
    const { items } = sourceItems(
      slice({ sources: [stale("a"), stale("b")], devices: [device(["a", "b"], 100)] }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.tier).toBe("blocking");
    expect(items[0]!.fix.question).toContain("`rhen sources a`");
    expect(items[0]!.fix.question).toContain("`rhen agent-token list`");
    // Every feed gets its own runnable command, with no "same for" tail.
    expect(items[0]!.fix.question).toContain("`rhen sources a`, `rhen sources b`");
    expect(items[0]!.fix.question).not.toMatch(/then the same|[<>]/);
  });

  it("names only the feed that stopped while the device is still heard from", () => {
    const { items } = sourceItems(
      slice({ sources: [feed("a", 60), feed("b", 2)], devices: [device(["a", "b"], 2)] }),
      NOW
    );
    expect(items.map((item) => item.id)).toEqual(["source_late:a"]);
  });

  it("does not make a device of a single feed: that feed's own item stays", () => {
    const { items } = sourceItems(slice({ sources: [feed("a", 60)], devices: [device(["a"], 60)] }), NOW);
    expect(items.map((item) => item.id)).toEqual(["source_late:a"]);
  });

  it("does not call a device silent that was never heard", () => {
    const never = source("a", { device: "phone", freshness: "never", configured: false, lastSuccessAt: null });
    expect(
      checks(
        slice({
          sources: [never, { ...never, id: "b" }],
          devices: [{ id: "phone", entries: ["a", "b"], lastSeenAt: null, lastSeenFrom: null }]
        })
      )
    ).toEqual([]);
  });
});

describe("registry wiring issues", () => {
  it("turns a probe_unresolved issue into a degrading item an agent can act on", () => {
    const { items } = sourceItems(
      slice({
        issues: [
          {
            code: "probe_unresolved",
            entryId: "x",
            tier: "degrading",
            title: "The health probe for X cannot be read: no table.",
            next: "Correct the health probe on entry x."
          }
        ]
      }),
      NOW
    );
    expect(items[0]).toMatchObject({
      id: "probe_unresolved:x",
      check: "probe_unresolved",
      tier: "degrading",
      fix: { who: "agent", cli: "rhen sources x", next: "Correct the health probe on entry x." }
    });
  });

  it("gives a revoked or expired token to the person, with the commands that list and mint tokens", () => {
    const { items } = sourceItems(
      slice({
        issues: [
          {
            code: "probe_unresolved",
            entryId: "x",
            tier: "degrading",
            title: "T",
            who: "person",
            next: "Run `rhen agent-token list`, then `rhen agent-token create`."
          }
        ]
      }),
      NOW
    );
    expect(items[0]!.fix).toMatchObject({ who: "person", cli: "rhen sources x" });
    expect(items[0]!.fix.question).toContain("rhen agent-token create");
    expect(items[0]!.fix.next).toBeUndefined();
  });

  it("turns token_not_bound into a tidy item", () => {
    const { items } = sourceItems(
      slice({
        issues: [
          { code: "token_not_bound", entryId: "x", tier: "tidy", title: "T", next: "Set tokenName for entry x." }
        ]
      }),
      NOW
    );
    expect(items[0]).toMatchObject({ id: "token_not_bound:x", tier: "tidy", fix: { who: "agent" } });
  });
});

describe("sources_collecting_unused", () => {
  it("is one tidy summary of rows that arrived this week into a partition nothing uses", () => {
    const { items } = sourceItems(
      slice({
        sources: [
          source("w", { name: "PC activity agent", reachEmpty: true, count7d: 4210 }),
          source("v", { name: "Voice notes", reachEmpty: true, count7d: 10 }),
          source("quiet-archive", { reachEmpty: true, count7d: 0 }),
          source("used", { reachEmpty: false, count7d: 500 })
        ]
      }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "sources_collecting_unused", tier: "tidy" });
    expect(items[0]!.title).toContain("4,220");
    expect(items[0]!.title).toContain("PC activity agent");
    expect(items[0]!.fix.cli).toBe("rhen sources --unused");
    expect(items[0]!.fix.question).toContain("`rhen sources --unused`");
  });

  it("raises nothing for a one-off archive that sits unused", () => {
    expect(checks(slice({ sources: [source("archive", { reachEmpty: true, count7d: 0 })] }))).toEqual([]);
  });
});

describe("import needs_review", () => {
  it("says how many rows the import skipped, at the tidy tier", () => {
    const { items } = sourceItems(
      slice({
        sources: [
          source("archive-export", {
            name: "Streaming history",
            freshness: "n/a",
            threshold: null,
            latestImport: { status: "needs_review", at: hoursAgo(5), skipped: 212 }
          })
        ]
      }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "import_needs_review:archive-export",
      check: "import_needs_review",
      tier: "tidy"
    });
    expect(items[0]!.title).toContain("212");
    expect(items[0]!.fix.question).toContain("`rhen import archive-export <path to the export file, zip or folder>`");
    expect(items[0]!.fix.question).not.toContain("<source>");
  });

  it("prints the import's own source name when it differs from the entry id", () => {
    const { items } = sourceItems(
      slice({
        sources: [
          source("archive-export", {
            activitySource: "archive",
            freshness: "n/a",
            threshold: null,
            latestImport: { status: "needs_review", at: hoursAgo(5), skipped: 2 }
          })
        ]
      }),
      NOW
    );
    expect(items[0]!.fix.question).toContain("`rhen import archive <path");
  });

  it("gives no item for a quiet import", () => {
    expect(
      checks(
        slice({
          sources: [
            source("a", {
              freshness: "n/a",
              threshold: null,
              latestImport: { status: "synced", at: hoursAgo(5), skipped: 0 }
            }),
            source("b", { freshness: "n/a", threshold: null, latestImport: null })
          ]
        })
      )
    ).toEqual([]);
  });
});

describe("the late count", () => {
  it("counts only the sources that have a source_late item, not sync sources or feeds folded into a device", () => {
    const late = (id: string, extra: Partial<DoctorSourceInput> = {}) =>
      source(id, { freshness: "late", lastSuccessAt: hoursAgo(30), ...extra });
    const { items, counts } = sourceItems(
      slice({
        sources: [
          late("a"),
          late("calendar", { keepsSyncChecks: true }),
          late("b", { device: "d" }),
          late("c", { device: "d" })
        ],
        devices: [{ id: "d", entries: ["b", "c"], lastSeenAt: hoursAgo(30), lastSeenFrom: "b" }]
      }),
      NOW
    );
    expect(items.filter((item) => item.check === "source_late").map((item) => item.id)).toEqual(["source_late:a"]);
    expect(counts.late).toBe(1);
    expect(counts.line).toBe("1 late · 1 device silent");
  });
});

describe("the counts line", () => {
  it("lists only what is not zero, in the headers' order", () => {
    expect(sourceCountsLine({ late: 4, deviceSilent: 1, collectedUnused: 11, nothingSends: 5 })).toBe(
      "4 late · 1 device silent · 11 collected, unused · 5 accepted, nothing sends"
    );
    expect(sourceCountsLine({ late: 0, deviceSilent: 2, collectedUnused: 0, nothingSends: 0 })).toBe(
      "2 devices silent"
    );
    expect(sourceCountsLine({ late: 0, deviceSilent: 0, collectedUnused: 0, nothingSends: 0 })).toBeNull();
  });
});

describe("inside runDoctor", () => {
  const base = (): DoctorSnapshot => ({
    now: new Date(NOW).toISOString(),
    freshness: {
      wake: { stale: false },
      session: { stale: false },
      energy: { stale: false },
      location: { stale: false },
      effort: []
    },
    pulseOffSince: null,
    projects: [],
    actions: [],
    routines: [],
    commitments: [],
    heldEvents: [],
    syncRuns: [],
    reviews: [],
    catchUpUnsettled: 0,
    openFindings: 0,
    proposalsWaiting: [],
    ...emptyDoctorSlices(new Date(NOW).toISOString())
  });

  it("changes nothing when the snapshot carries no sources slice", () => {
    const report = runDoctor(base());
    expect(report.healthy).toBe(true);
    expect(report.sources).toBeUndefined();
  });

  it("adds the items and the counts, and the report is no longer healthy", () => {
    const report = runDoctor({
      ...base(),
      sources: slice({ sources: [source("a", { freshness: "late", lastSuccessAt: hoursAgo(30) })], unused: 3 })
    });
    expect(report.healthy).toBe(false);
    expect(report.items.map((item) => item.id)).toEqual(["source_late:a"]);
    expect(report.sources).toMatchObject({ late: 1, collectedUnused: 3, line: "1 late · 3 collected, unused" });
  });

  it("lists every source check as not run when the probes could not be read", () => {
    const report = runDoctor({ ...base(), sources: slice({ unavailable: true }) });
    expect(report.notChecked.map((entry) => entry.check)).toEqual(expect.arrayContaining([...DOCTOR_SOURCE_CHECKS]));
    expect(report.notChecked.find((entry) => entry.check === "source_late")!.reason).toContain(
      "rhen sources --problems"
    );
    expect(report.notChecked.find((entry) => entry.check === "source_late")!.reason).toContain("rhen doctor");
    expect(report.items).toEqual([]);
  });

  it("drops location_ping_silent when the phone device is reported silent", () => {
    const snapshot = base();
    snapshot.recording.phonePing = { configured: true, lastPingAt: hoursAgo(100) };
    expect(runDoctor(snapshot).items.map((item) => item.check)).toContain("location_ping_silent");
    const feed = (id: string, extra: Partial<DoctorSourceInput> = {}) =>
      source(id, {
        device: "phone",
        freshness: "late",
        lastSuccessAt: hoursAgo(100),
        threshold: { warnHours: 24, errorHours: 72, from: "default" },
        ...extra
      });
    const report = runDoctor({
      ...snapshot,
      sources: slice({
        sources: [feed("a"), feed("phone-location", { phonePing: true })],
        devices: [{ id: "phone", entries: ["a", "phone-location"], lastSeenAt: hoursAgo(100), lastSeenFrom: "a" }]
      })
    });
    expect(report.items.map((item) => item.check)).toEqual(["device_silent"]);
  });
});
