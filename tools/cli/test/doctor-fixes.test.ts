import { emptyDoctorSlices, MCP_TOOL_MANIFEST, runDoctor, type DoctorSnapshot } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { commands } from "../src/registry.js";

const NOW = "2026-10-29T00:00:00.000Z";
const day = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();

/** A snapshot with every check firing, so every fix the doctor can name is produced. */
const EVERYTHING_WRONG: DoctorSnapshot = {
  now: NOW,
  freshness: {
    wake: { stale: true, asOf: day(-3) },
    session: { stale: true, asOf: day(-1) },
    energy: { stale: true },
    location: { stale: true, asOf: day(-2) },
    effort: []
  },
  pulseOffSince: day(-1),
  projects: [
    {
      id: "p1",
      title: "Idle",
      status: "active",
      lastWorkedAt: day(-40),
      focus: false,
      openActionCount: 1,
      openDeliverableCount: 0,
      externalDeadlineAt: day(-2)
    },
    {
      id: "p2",
      title: "Empty",
      status: "active",
      lastWorkedAt: day(-1),
      focus: false,
      openActionCount: 0,
      openDeliverableCount: 1,
      externalDeadlineAt: null
    }
  ],
  actions: [
    {
      id: "a1",
      title: "Write",
      projectId: null,
      status: "planned",
      lastWorkedAt: null,
      assumedFields: [],
      hasEstimate: false
    }
  ],
  routines: [
    {
      id: "r1",
      title: "Run",
      intervalDays: 2,
      lastCompletedAt: day(-10),
      startedAt: day(-60),
      endDate: day(-1),
      status: "active"
    }
  ],
  commitments: [
    { id: "c1", title: "Dinner", startsAt: day(1), status: "scheduled", missingPlace: true, missingTransport: true }
  ],
  heldEvents: [{ batchId: "b1", provider: "google_calendar", heldSince: day(-5) }],
  syncRuns: [{ provider: "example_daily", status: "failed", lastSuccessAt: day(-3), lastRunAt: day(0) }],
  reviews: [{ id: "ar1", type: "area", title: "Health", dueAt: day(-1) }],
  catchUpUnsettled: 3,
  openFindings: 2,
  proposalsWaiting: [{ id: "pr1", waitingSince: day(-20) }],
  ...emptyDoctorSlices(NOW),
  sources: {
    sources: [
      {
        id: "feed-a",
        name: "Feed A",
        keepsSyncChecks: false,
        device: "phone",
        engineReads: false,
        configured: true,
        freshness: "late",
        lastSuccessAt: day(-4),
        threshold: { warnHours: 24, errorHours: 72, from: "default" },
        reachEmpty: true,
        count7d: 12
      },
      {
        id: "feed-b",
        name: "Feed B",
        keepsSyncChecks: false,
        device: "phone",
        engineReads: false,
        configured: true,
        freshness: "late",
        lastSuccessAt: day(-4),
        threshold: { warnHours: 24, errorHours: 72, from: "default" },
        reachEmpty: false
      },
      {
        id: "feed-c",
        name: "Feed C",
        keepsSyncChecks: false,
        engineReads: true,
        configured: true,
        freshness: "stale",
        lastSuccessAt: day(-9),
        threshold: { warnHours: 24, errorHours: 72, from: "default" },
        reachEmpty: false
      },
      {
        id: "feed-d",
        name: "Feed D",
        keepsSyncChecks: false,
        engineReads: false,
        configured: false,
        credentialPresent: true,
        freshness: "never",
        lastSuccessAt: null,
        threshold: null,
        reachEmpty: false
      },
      {
        id: "archive",
        name: "Archive",
        keepsSyncChecks: false,
        engineReads: false,
        configured: true,
        freshness: "n/a",
        lastSuccessAt: day(-2),
        threshold: null,
        reachEmpty: false,
        latestImport: { status: "needs_review", at: day(-2), skipped: 7 }
      }
    ],
    devices: [{ id: "phone", entries: ["feed-a", "feed-b"], lastSeenAt: day(-4), lastSeenFrom: "feed-a" }],
    issues: [
      { code: "probe_unresolved", entryId: "feed-e", tier: "degrading", title: "T", next: "Fix feed-e." },
      { code: "token_not_bound", entryId: "feed-f", tier: "tidy", title: "T", next: "Bind feed-f." }
    ],
    unused: 2,
    nothingSends: 1
  }
};

describe("the fixes doctor names", () => {
  const items = runDoctor(EVERYTHING_WRONG).items;
  const withTool = items.filter((item) => item.fix.tool !== undefined);
  const withCli = items.filter((item) => item.fix.cli !== undefined);

  it("exercises every kind of item", () => {
    expect(new Set(items.map((item) => item.check)).size).toBeGreaterThanOrEqual(15);
  });

  it("exercises every source check, so each of their fixes is checked below", () => {
    const checks = new Set(items.map((item) => item.check));
    for (const check of [
      "source_late",
      "source_silent",
      "device_silent",
      "probe_unresolved",
      "token_not_bound",
      "sources_collecting_unused",
      "import_needs_review"
    ] as const)
      expect(checks, check).toContain(check);
  });

  it("gives every agent fix on a source check a next step in words", () => {
    const agentFixes = items.filter((item) => ["probe_unresolved", "token_not_bound"].includes(item.check));
    expect(agentFixes).toHaveLength(2);
    for (const item of agentFixes) expect(item.fix.next?.length ?? 0).toBeGreaterThan(10);
  });

  it.each(withTool.map((item) => [item.check, item.fix.tool!] as const))(
    "%s names a served MCP tool (%s)",
    (_check, tool) => {
      expect(MCP_TOOL_MANIFEST.map((entry) => entry.name)).toContain(tool);
    }
  );

  it.each(withCli.map((item) => [item.check, item.fix.cli!] as const))(
    "%s names a registered command (%s)",
    (_check, cli) => {
      const verb = /^rhen ([a-z-]+)/.exec(cli)?.[1];
      expect(commands.map((command) => command.name)).toContain(verb);
    }
  );

  it("only names options the command takes", () => {
    for (const item of withCli) {
      const verb = /^rhen ([a-z-]+)/.exec(item.fix.cli!)![1]!;
      const command = commands.find((candidate) => candidate.name === verb)!;
      for (const [, option] of item.fix.cli!.matchAll(/ --([a-z-]+)/g)) {
        expect(Object.keys(command.options), `${item.check}: --${option}`).toContain(option);
      }
    }
  });
});
