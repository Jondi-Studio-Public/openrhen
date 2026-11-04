import { describe, expect, it } from "vitest";
import { DOCTOR_CHECKS, emptyDoctorSlices, runDoctor, type DoctorItem, type DoctorSnapshot } from "./doctor.js";

const NOW = "2026-10-29T00:00:00.000Z";
const day = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();

function snapshot(over: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return {
    now: NOW,
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
    ...emptyDoctorSlices(NOW),
    ...over
  };
}

const emitted: DoctorItem[] = [];
const run: typeof runDoctor = (snap) => {
  const report = runDoctor(snap);
  emitted.push(...report.items);
  return report;
};

describe("runDoctor", () => {
  it("is healthy when nothing is found, and still lists what it cannot check", () => {
    const report = run(snapshot());
    expect(report.healthy).toBe(true);
    expect(report.items).toEqual([]);
    expect(report.notChecked.map((n) => n.check)).toContain("dismissed_still_linked");
  });

  it("ranks blocking before degrading before tidy, then soon-dated, then oldest", () => {
    const report = run(
      snapshot({
        freshness: {
          wake: { stale: true, asOf: day(-3) },
          session: { stale: false },
          energy: { stale: true },
          location: { stale: false },
          effort: []
        },
        commitments: [
          {
            id: "far",
            title: "Far",
            startsAt: day(6),
            status: "scheduled",
            missingPlace: true,
            missingTransport: false
          },
          {
            id: "near",
            title: "Near",
            startsAt: day(2),
            status: "scheduled",
            missingPlace: true,
            missingTransport: false
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
        ]
      })
    );
    expect(report.items.map((i) => i.id)).toEqual([
      "commitment_detail:near",
      "commitment_detail:far",
      "stale_wake",
      "no_estimate:a1",
      "stale_energy"
    ]);
    expect(report.counts).toEqual({ blocking: 3, degrading: 1, tidy: 1 });
    expect(report.healthy).toBe(false);
  });

  it("skips a commitment far out or fully specified, and a sync that is not configured", () => {
    const report = run(
      snapshot({
        commitments: [
          {
            id: "late",
            title: "Later",
            startsAt: day(20),
            status: "scheduled",
            missingPlace: true,
            missingTransport: false
          },
          {
            id: "ok",
            title: "Fine",
            startsAt: day(1),
            status: "scheduled",
            missingPlace: false,
            missingTransport: false
          }
        ],
        syncRuns: [{ provider: "example_shared", status: "not_configured", lastSuccessAt: null, lastRunAt: null }]
      })
    );
    expect(report.items).toEqual([]);
  });

  it("reports a failing sync with status only and an event held over 3 days", () => {
    const report = run(
      snapshot({
        syncRuns: [{ provider: "example_daily", status: "failed", lastSuccessAt: day(-2), lastRunAt: day(0) }],
        heldEvents: [
          { batchId: "b1", provider: "google_calendar", heldSince: day(-4) },
          { batchId: "b2", provider: "example_shared", heldSince: day(-1) }
        ]
      })
    );
    expect(report.items.map((i) => i.id)).toEqual(["event_held:b1", "sync_failing:example_daily"]);
    expect(report.items.every((i) => i.fix.who === "person")).toBe(true);
  });

  it("flags a connection whose diff profile is not registered as blocking", () => {
    const report = run(snapshot({ unregisteredDiffProfiles: [{ connectionId: "example_daily", profile: "roster" }] }));
    expect(report.items).toMatchObject([
      { id: "diff_profile_unregistered:example_daily", check: "diff_profile_unregistered", tier: "blocking" }
    ]);
    expect(run(snapshot({})).items).toEqual([]);
  });

  it("flags the pulse staying off as blocking", () => {
    const report = run(snapshot({ pulseOffSince: day(-1) }));
    expect(report.items[0]).toMatchObject({ id: "pulse_off", tier: "blocking" });
  });

  it("asks about idle projects, never decides, and spares focus projects", () => {
    const base = { status: "active", openActionCount: 1, openDeliverableCount: 0, externalDeadlineAt: null };
    const report = run(
      snapshot({
        projects: [
          { id: "p1", title: "Idle", lastWorkedAt: day(-40), focus: false, ...base },
          { id: "p2", title: "Focus", lastWorkedAt: day(-40), focus: true, ...base },
          {
            id: "p3",
            title: "Empty",
            lastWorkedAt: day(-1),
            focus: false,
            ...base,
            openActionCount: 0,
            openDeliverableCount: 2
          }
        ]
      })
    );
    expect(report.items.map((i) => i.id)).toEqual(["nothing_to_do:p3", "idle_project:p1"]);
    expect(report.items[1]!.fix.who).toBe("person");
  });

  it("flags a lapsed routine and an ended series, and an assumed estimate", () => {
    const report = run(
      snapshot({
        routines: [
          {
            id: "r1",
            title: "Run",
            intervalDays: 2,
            lastCompletedAt: day(-10),
            startedAt: day(-60),
            endDate: null,
            status: "active"
          },
          {
            id: "r2",
            title: "Course",
            intervalDays: 7,
            lastCompletedAt: day(-1),
            startedAt: day(-60),
            endDate: day(-2),
            status: "active"
          }
        ],
        actions: [
          {
            id: "a2",
            title: "Read",
            projectId: null,
            status: "active",
            lastWorkedAt: null,
            assumedFields: ["expectedMinutes"],
            hasEstimate: true
          }
        ]
      })
    );
    expect(report.items.map((i) => i.check).sort()).toEqual(["no_estimate", "routine_ended", "routine_lapsed"]);
  });

  it("flags a routine never done once three intervals have passed since it started", () => {
    const report = run(
      snapshot({
        routines: [
          {
            id: "new",
            title: "New",
            intervalDays: 7,
            lastCompletedAt: null,
            startedAt: day(-3),
            endDate: null,
            status: "active"
          },
          {
            id: "old",
            title: "Old",
            intervalDays: 7,
            lastCompletedAt: null,
            startedAt: day(-30),
            endDate: null,
            status: "active"
          }
        ]
      })
    );
    expect(report.items.map((i) => i.id)).toEqual(["routine_lapsed:old"]);
    expect(report.items[0]!.title).toContain("never done");
  });

  it("flags a project past its external deadline, and asks rather than decides", () => {
    const report = run(
      snapshot({
        projects: [
          {
            id: "p",
            title: "Late",
            status: "active",
            lastWorkedAt: day(-1),
            focus: false,
            openActionCount: 1,
            openDeliverableCount: 0,
            externalDeadlineAt: day(-2)
          }
        ]
      })
    );
    expect(report.items[0]).toMatchObject({ id: "deadline_passed:p", tier: "degrading" });
    expect(report.items[0]!.fix.who).toBe("person");
  });

  it("names both a missing place and a missing travel mode", () => {
    const report = run(
      snapshot({
        commitments: [
          {
            id: "c",
            title: "Dinner",
            startsAt: day(1),
            status: "scheduled",
            missingPlace: true,
            missingTransport: true
          }
        ]
      })
    );
    expect(report.items[0]!.title).toBe("Dinner needs a place and a travel mode");
    expect(report.items[0]!.fix.fields).toEqual(["locationId", "transportMode"]);
  });

  it("asks about a remaining time the forecast aged, behind projects first", () => {
    const effort = (actionId: string, health: "behind" | "at_risk", stale = true) => ({
      actionId,
      projectId: `p-${actionId}`,
      title: `Task ${actionId}`,
      remainingMinutes: 90,
      health,
      asOf: "2026-10-01T00:00:00.000Z",
      staleAt: "2026-10-15T00:00:00.000Z",
      stale
    });
    const base = snapshot();
    const report = run(
      snapshot({
        freshness: {
          ...base.freshness,
          effort: [effort("a1", "at_risk"), effort("a2", "behind"), effort("a3", "behind", false)]
        }
      })
    );
    const aged = report.items.filter((item) => item.check === "aged_estimate");
    expect(aged.map((item) => item.id)).toEqual(["aged_estimate:a1", "aged_estimate:a2"]);
    expect(aged[0]).toMatchObject({ tier: "degrading", area: "plan", fix: { who: "person" } });
  });
  it("lists the checks it does not run, so a healthy summary claims nothing more", () => {
    const report = run(snapshot());
    expect(report.healthy).toBe(true);
    expect(report.notChecked.map((n) => n.check)).toEqual(expect.arrayContaining(["dismissed_still_linked"]));
  });

  it("reduces the owned ledgers to one line each", () => {
    const report = run(snapshot({ catchUpUnsettled: 4, openFindings: 2 }));
    expect(report.items.map((i) => i.id)).toEqual(["catch_up_unsettled", "open_findings"]);
  });

  it("names every check once, and every item the fixtures emit carries a named check", () => {
    expect(new Set(DOCTOR_CHECKS).size).toBe(DOCTOR_CHECKS.length);
    expect(emitted.length).toBeGreaterThan(0);
    const named = new Set<string>(DOCTOR_CHECKS);
    for (const item of emitted) expect(named.has(item.check)).toBe(true);
  });
});
