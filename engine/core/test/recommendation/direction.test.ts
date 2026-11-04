import { describe, expect, it } from "vitest";
import { conditionDefinitionSchema, currentSituationSchema, type DeliverableProjection } from "@openrhen/contracts";
import {
  CRITICAL_TIERS,
  CRITICAL_TIER_LABELS,
  ORDINARY_RANK,
  assessCritical,
  effectiveDeadline,
  planSchedule,
  rankOf,
  recommend,
  resolvePlanningCapacity,
  tierOf
} from "../../src/index.js";
import { deliverableForecastUnits } from "../../src/scheduling/deliverables.js";
import { formatDate, localiseTimes } from "../../src/recommendation/format.js";
import type { Action, CapacityWindow, Project, ProjectForecast } from "../../src/index.js";

const now = new Date("2026-08-07T07:00:00.000Z");
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS);
const minutes = (count: number) => new Date(now.getTime() + count * MINUTE_MS);
const horizonEnd = days(180);
/** The headline's own date format, so a test can look for the exact date it should (or should not) name. */
const formatHeadlineDate = (value: Date) =>
  new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(value);
const timezone = "Australia/Sydney";
const locale = "en-AU";

const automatic = (): CapacityWindow[] =>
  resolvePlanningCapacity({
    now,
    horizonEnd,
    usableFraction: 0.75,
    timezone,
    dayStartTime: "07:00",
    dayEndTime: "22:00"
  });

function project(id: string, deadlineDays: number | null, overrides: Partial<Project> = {}): Project {
  return {
    id,
    status: "active",
    uncertainty: "known",
    value: 3,
    consequence: 3,
    outcomeActive: true,
    ...(deadlineDays === null ? {} : { internalDeadlineAt: days(deadlineDays) }),
    ...overrides
  };
}

function action(id: string, projectId: string, minutes: number, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectId,
    title: id,
    status: "active",
    optimisticMinutes: Math.round(minutes * 0.8),
    expectedMinutes: minutes,
    pessimisticMinutes: Math.round(minutes * 1.4),
    remainingMinutes: minutes,
    energy: "high",
    minimumSessionMinutes: 30,
    maximumSessionMinutes: 60,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependenciesComplete: true,
    dependencyIds: [],
    splittable: true,
    setupMinutes: 0,
    ...overrides
  };
}

function run(
  projects: Project[],
  actions: Action[],
  overrides: Partial<Parameters<typeof recommend>[0]> = {},
  capacityWindows = automatic(),
  unknownEffortDeliverables?: { projectId: string; title: string }[]
) {
  const schedule = planSchedule({
    now,
    horizonEnd,
    projects,
    actions,
    capacityWindows,
    commitments: overrides.commitments ?? [],
    projectedDailyProtectedMinutes: 30,
    ...(unknownEffortDeliverables ? { unknownEffortDeliverables } : {})
  });
  const result = recommend({
    now,
    horizonEnd,
    projects,
    actions,
    planning: schedule,
    forecasts: schedule.forecasts,
    capacityWindows,
    commitments: [],
    currentEnergy: "high",
    timezone,
    locale,
    ...overrides
  });
  return { result, schedule };
}

function forecastOf(overrides: Partial<ProjectForecast>): ProjectForecast {
  return {
    projectId: "p",
    health: "unknown",
    overdue: false,
    protectedRemainingMinutes: null,
    pessimisticRemainingMinutes: null,
    compatibleCapacityMinutes: null,
    grossCompatibleCapacityMinutes: null,
    reservedByEarlierDeadlinesMinutes: 0,
    requiredPaceMinutesPerWeek: null,
    forecastBand: null,
    confidence: null,
    forecastThrough: horizonEnd,
    expectedMarginMinutes: null,
    pessimisticMarginMinutes: null,
    marginRatio: null,
    scheduleVariance: null,
    unallocatedExpectedMinutes: 0,
    blockedEffortMinutes: 0,
    schedulingBlocked: false,
    latestSafeStarts: {},
    reasons: [],
    ...overrides
  };
}

describe("named deadline ladder", () => {
  it("numbers every tier in order and names every number", () => {
    expect(CRITICAL_TIERS).toHaveLength(7);
    for (const [index, tier] of CRITICAL_TIERS.entries()) {
      expect(rankOf(tier)).toBe(index);
      expect(tierOf(index as ReturnType<typeof rankOf>)).toBe(tier);
      expect(CRITICAL_TIER_LABELS[tier]).toBeTruthy();
    }
    // A stale date is off the ladder: it ranks with ordinary work and is told apart by name.
    expect(rankOf("stale_date")).toBe(ORDINARY_RANK);
    expect(CRITICAL_TIER_LABELS.stale_date).toBeTruthy();
  });

  it("promotes a close external deadline the forecast cannot measure to sit with committed external work, but ranks the same self-set date ordinary with a bonus", () => {
    const external = project("p", 3, { externalDeadlineAt: days(4) });
    const unit = action("a", "p", 60);
    const promoted = assessCritical({
      now,
      locale,
      action: unit,
      project: external,
      forecast: forecastOf({ health: "unknown" })
    });
    expect(promoted.tier).toBe("due_this_week_external");
    expect(promoted.rank).toBe(rankOf("due_this_week_external"));
    const internal = assessCritical({
      now,
      locale,
      action: unit,
      project: project("p", 3),
      forecast: forecastOf({ health: "unknown" })
    });
    expect(internal.tier).toBe("ordinary");
    expect(internal.rank).toBe(ORDINARY_RANK);
    expect(internal.selfSetDeadlineBonus).toBe(30);
    const measuredInternal = assessCritical({
      now,
      locale,
      action: unit,
      project: project("p", 3),
      forecast: forecastOf({ health: "on_track" })
    });
    expect(measuredInternal.tier).toBe("ordinary");
    expect(measuredInternal.selfSetDeadlineBonus).toBe(45);
    const cadenceInternal = assessCritical({
      now,
      locale,
      action: action("a-cadence", "p", 60, {
        cadence: { intervalDays: 1, timezone, startDate: "2026-08-01", completionCount: 0 }
      }),
      project: project("p", 3),
      forecast: forecastOf({ health: "on_track" })
    });
    expect(cadenceInternal.selfSetDeadlineBonus).toBeUndefined();
  });

  it("puts an overdue self-set deadline in the stale-date tier with a move-the-date proposal", () => {
    // A passed self-set date is stale, not overdue: it ranks as ordinary
    // work with no deadline pressure, so the live project leads and the stale one is told apart by tier.
    const projects = [project("live", 5), project("slipped", -3)];
    const actions = [action("live-work", "live", 120), action("slipped-work", "slipped", 90)];
    const { result, schedule } = run(projects, actions);
    const slipped = schedule.forecasts.find((item) => item.projectId === "slipped")!;
    expect(slipped.overdue).toBe(true);
    expect(slipped.health).toBe("behind");
    expect(slipped.proposal?.deadlineOwner).toBe("internal");
    expect(slipped.proposal?.earliestFeasibleAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(slipped.proposal?.reason).toContain("Move it to");
    expect(result.primary?.action.id).toBe("live-work");
    const winner = result.candidates.find((item) => item.action.id === "slipped-work")!;
    expect(winner.criticalTier).toBe("stale_date");
    // No deadline pressure: the lapsed date contributes nothing to capacity pressure.
    expect(winner.scoreComponents.capacityPressure).toBe(0);
    expect(winner.proposal).toEqual({
      ...slipped.proposal,
      reason: localiseTimes(slipped.proposal!.reason, timezone, locale)
    });
    expect(winner.criticalReason).toContain("self-set date passed");
    const other = result.candidates.find((item) => item.action.id === "live-work")!;
    expect(other.criticalTier).toBe("ordinary");
    expect(other.scoreComponents.selfSetDeadline).toBeGreaterThan(0);
  });

  it("keeps an overdue external deadline on top and says the date has passed", () => {
    const projects = [project("missed", -1, { externalDeadlineAt: days(-1) }), project("live", 5)];
    const actions = [action("missed-work", "missed", 120), action("live-work", "live", 120)];
    const { result, schedule } = run(projects, actions);
    expect(result.primary?.action.id).toBe("missed-work");
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.primary?.criticalReason).toContain("renegotiate it or record the outcome");
    expect(schedule.forecasts.find((item) => item.projectId === "missed")?.proposal?.deadlineOwner).toBe("external");
  });

  it("calls a passed self-set target an own-target miss when the external date is still ahead", () => {
    // The owner's own target slipped (yesterday) but the external commitment is three days out. The old
    // text said the externally committed date passed and ranked it overdue_external, above everything.
    const externalDeadlineAt = days(3);
    const projects = [
      project("slipped-target", -1, { externalDeadlineAt }),
      project("live", 2, { externalDeadlineAt: days(2) })
    ];
    const actions = [action("slipped-work", "slipped-target", 60), action("live-work", "live", 60)];
    const { result, schedule } = run(projects, actions);
    const slipped = schedule.forecasts.find((item) => item.projectId === "slipped-target")!;
    expect(slipped.overdue).toBe(true);
    expect(slipped.proposal?.deadlineOwner).toBe("internal");
    expect(slipped.proposal?.missedDeadlineAt.getTime()).toBe(days(-1).getTime());
    expect(slipped.proposal?.reason).toContain("Your own target passed");
    expect(slipped.proposal?.reason).toContain(externalDeadlineAt.toISOString());
    expect(slipped.proposal?.reason).not.toContain("externally committed date passed");
    expect(slipped.proposal?.reason).not.toContain("renegotiate");
    const candidate = result.candidates.find((item) => item.action.id === "slipped-work")!;
    expect(candidate.criticalTier).not.toBe("overdue_external");
    expect(candidate.criticalTier).toBe("at_risk_external");
    expect(candidate.criticalReason).toContain("Your own target passed");
    // The genuinely nearer external deadline is not pre-empted by the slipped self-set target.
    expect(result.primary?.criticalTier).not.toBe("overdue_external");
    expect(result.explanation).toContain("Your own target");
    expect(result.explanation).not.toContain("The external deadline");
  });

  it("names the project's missed own target when the action carries its own later deadline", () => {
    // The project's own target passed yesterday and the external date is three days out, but the
    // action has its own deadline two days away. The effective deadline prefers that later date, so
    // the headline has to take the missed target from the forecast's proposal instead.
    const externalDeadlineAt = days(3);
    const projects = [project("slipped-target", -1, { externalDeadlineAt })];
    const actions = [action("slipped-work", "slipped-target", 60, { deadlineAt: days(2) })];
    const { result, schedule } = run(projects, actions);
    const slipped = schedule.forecasts.find((item) => item.projectId === "slipped-target")!;
    expect(slipped.overdue).toBe(true);
    expect(slipped.proposal?.deadlineOwner).toBe("internal");
    expect(result.primary?.criticalReason).toContain("Your own target passed");
    const formatted = (at: Date) =>
      new Intl.DateTimeFormat("en-AU", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone
      }).format(at);
    expect(result.explanation).toContain(`Your own target (${formatted(days(-1))}) has passed`);
    expect(result.explanation).toContain(`external deadline (${formatted(externalDeadlineAt)}) is still ahead`);
  });

  it("names the candidate's nearer external date without a fit claim the project forecast cannot back", () => {
    // The project's own target passed yesterday and its external date is ten days out, but the
    // selected deliverable's own external date is 20 minutes away. The proposal's fit check covers
    // the whole project against the project date, so it says nothing about this deliverable and
    // its date: the reason names the passed target and the nearer date, and claims no fit either way.
    const projectExternal = days(10);
    const actionExternal = minutes(20);
    const projects = [project("slipped-target", -1, { externalDeadlineAt: projectExternal })];
    const actions = [action("slipped-work", "slipped-target", 60, { externalDeadlineAt: actionExternal })];
    const { result, schedule } = run(projects, actions);
    const slipped = schedule.forecasts.find((item) => item.projectId === "slipped-target")!;
    expect(slipped.proposal?.deadlineOwner).toBe("internal");
    // The proposal itself still speaks about the project date and says the work fits before it.
    expect(slipped.proposal?.reason).toContain(projectExternal.toISOString());
    const reason = result.primary?.criticalReason ?? "";
    expect(reason).toBe(
      `Your own target passed at ${formatDate(slipped.proposal!.missedDeadlineAt, timezone, locale)}, but the external date ${formatDate(actionExternal, timezone, locale)} is still ahead.`
    );
    expect(reason).not.toContain(projectExternal.toISOString());
    expect(reason).not.toMatch(/fit/);
    // When the project's own date is the one named, the proposal's reason (and its fit check) stands.
    const sameDate = run(
      [project("slipped-target", -1, { externalDeadlineAt: projectExternal })],
      [action("slipped-work", "slipped-target", 60)]
    );
    expect(sameDate.result.primary?.criticalReason).toBe(
      localiseTimes(
        sameDate.schedule.forecasts.find((item) => item.projectId === "slipped-target")!.proposal!.reason,
        timezone,
        locale
      )
    );
  });

  it("does not report a passed external date inside the last buffer hour before it", () => {
    // External at 17:00 local with the default 60-minute submission buffer, evaluated at 16:15: the
    // derived internal date (16:00) is behind us but the commitment is 45 minutes away. Replayed for
    // every minute of the buffer hour: none of them is an external miss.
    const externalDeadlineAt = minutes(120);
    const projects = [project("buffered", null, { externalDeadlineAt })];
    const actions = [action("buffered-work", "buffered", 30)];
    for (const offset of [61, 75, 100, 119]) {
      const at = minutes(offset);
      const schedule = planSchedule({
        now: at,
        horizonEnd,
        projects,
        actions,
        capacityWindows: resolvePlanningCapacity({
          now: at,
          horizonEnd,
          usableFraction: 0.75,
          timezone,
          dayStartTime: "00:00",
          dayEndTime: "00:00"
        }),
        commitments: [],
        projectedDailyProtectedMinutes: 30
      });
      const forecast = schedule.forecasts[0]!;
      expect(forecast.overdue).toBe(true);
      expect(forecast.proposal?.deadlineOwner).toBe("internal");
      expect(forecast.proposal?.reason).not.toContain("externally committed date passed");
      expect(forecast.proposal?.reason).toContain(externalDeadlineAt.toISOString());
      const assessment = assessCritical({ now: at, action: actions[0]!, project: projects[0]!, forecast });
      expect(assessment.tier).toBe("at_risk_external");
      expect(assessment.reason).not.toContain("externally committed date");
    }
  });

  it("says the external date passed, at the external date, once it actually has", () => {
    // Derived internal date (external less the buffer) differs from the external date: the message
    // must name the date that passed, which is the external one, and the tier stays overdue_external.
    const externalDeadlineAt = minutes(-30);
    const projects = [project("missed", null, { externalDeadlineAt })];
    const actions = [action("missed-work", "missed", 30)];
    const { result, schedule } = run(projects, actions);
    const forecast = schedule.forecasts[0]!;
    expect(forecast.internalDeadlineAt!.getTime()).toBeLessThan(externalDeadlineAt.getTime());
    expect(forecast.proposal?.deadlineOwner).toBe("external");
    expect(forecast.proposal?.missedDeadlineAt.getTime()).toBe(externalDeadlineAt.getTime());
    expect(forecast.proposal?.reason).toContain(
      `The externally committed date passed at ${externalDeadlineAt.toISOString()}`
    );
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.primary?.criticalReason).toContain("renegotiate it or record the outcome");
  });

  it("reads a deliverable's own external date, not only its project's, to tell a passed commitment from a passed target", () => {
    const external = project("p", null, { externalDeadlineAt: days(30) });
    const passedExternal = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(-2), externalDeadlineAt: days(-2) }),
      project: external,
      forecast: forecastOf({ health: "on_track" })
    });
    expect(passedExternal.tier).toBe("overdue_external");
    const passedTarget = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(-2), externalDeadlineAt: days(5) }),
      project: external,
      forecast: forecastOf({ health: "on_track" })
    });
    expect(passedTarget.tier).toBe("at_risk_external");
    expect(passedTarget.reason).toContain(formatDate(days(5), undefined, locale));
  });

  it("takes project forecast health's owner from the project's deadline, not a deliverable's later external date", () => {
    // The project has only a self-set deadline; one deliverable carries a much later external date.
    // Project-level "behind" and "at risk" measure the self-set date, so they must not claim an
    // external deadline cannot be met.
    const selfSet = project("p", 3);
    const unit = action("d", "p", 60, { externalDeadlineAt: days(60) });
    const behind = assessCritical({ now, action: unit, project: selfSet, forecast: forecastOf({ health: "behind" }) });
    expect(behind.tier).toBe("behind_internal");
    expect(behind.reason).toContain("self-set");
    expect(behind.reason).not.toContain("externally");
    const atRisk = assessCritical({ now, action: unit, project: selfSet, forecast: forecastOf({ health: "at_risk" }) });
    expect(atRisk.tier).toBe("at_risk_internal");
    const margin = assessCritical({
      now,
      locale,
      action: unit,
      project: selfSet,
      forecast: forecastOf({ health: "on_track", marginRatio: 0.01 })
    });
    expect(margin.tier).toBe("at_risk_internal");
    expect(margin.reason).toContain("self-set");
    // A project whose only deadline is its external date is measured against it, so its forecast is external.
    const external = project("p", null, { externalDeadlineAt: days(5) });
    expect(
      assessCritical({ now, action: unit, project: external, forecast: forecastOf({ health: "behind" }) }).tier
    ).toBe("behind_external");
  });

  it("measures project health and the latest safe start against the internal target even when the external date is near", () => {
    // Internal target tomorrow, external date six days out: the forecast was measured against tomorrow,
    // so being behind or losing the latest safe start is a self-set miss. Proximity is not ownership.
    const nearBoth = project("p", 1, { externalDeadlineAt: days(6) });
    const unit = action("d", "p", 60);
    expect(
      assessCritical({ now, action: unit, project: nearBoth, forecast: forecastOf({ health: "behind" }) }).tier
    ).toBe("behind_internal");
    expect(
      assessCritical({ now, action: unit, project: nearBoth, forecast: forecastOf({ health: "at_risk" }) }).tier
    ).toBe("at_risk_internal");
    expect(
      assessCritical({
        now,
        action: unit,
        project: nearBoth,
        forecast: forecastOf({ health: "on_track", marginRatio: 0.5, latestSafeStarts: { d: minutes(60) } })
      }).tier
    ).toBe("at_risk_internal");
    // The due-this-week branch is where a near external date counts: internal in 3 days, external in 4.
    expect(
      assessCritical({
        now,
        action: unit,
        project: project("p", 3, { externalDeadlineAt: days(4) }),
        forecast: forecastOf({ health: "unknown" })
      }).tier
    ).toBe("due_this_week_external");
  });

  it("builds the overdue reason from the earliest passed external date, not the project's proposal", () => {
    // Both the project's external date (1 day ago) and the deliverable's own, earlier one (3 days ago)
    // have passed. The headline names the earlier date, so the reason must too; the project's proposal
    // was built from the later date and the whole project's work and would name the wrong one.
    const proposal = {
      deadlineOwner: "external",
      missedDeadlineAt: days(-1),
      reason: `The externally committed date passed at ${days(-1).toISOString()}; the remaining work would not have fit.`
    } as unknown as NonNullable<ProjectForecast["proposal"]>;
    const forecast = forecastOf({ health: "behind", overdue: true, proposal });
    const earlierUnit = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(-3), externalDeadlineAt: days(-3) }),
      project: project("p", null, { externalDeadlineAt: days(-1) }),
      forecast
    });
    expect(earlierUnit.tier).toBe("overdue_external");
    expect(earlierUnit.reason).toContain(formatDate(days(-3), undefined, locale));
    expect(earlierUnit.reason).not.toContain(formatDate(days(-1), undefined, locale));
    expect(earlierUnit.reason).not.toContain("would not have fit");
    // When the project's own date is the one that passed first, its proposal is honest and is used.
    const projectFirst = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(-1), externalDeadlineAt: days(-1) }),
      project: project("p", null, { externalDeadlineAt: days(-1) }),
      forecast
    });
    expect(projectFirst.reason).toBe(proposal.reason);
  });

  it("keeps a near self-set target out of the external tier when the unit's external date is much later", () => {
    const forecast = forecastOf({ health: "on_track" });
    // A deliverable's internal target in 3 days against an external date in 30.
    const unit = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(3), externalDeadlineAt: days(30) }),
      project: project("p", null),
      forecast
    });
    expect(unit.tier).toBe("ordinary");
    expect(unit.selfSetDeadlineBonus).toBe(45);
    // The same for a project whose internal target is near and whose external date is far.
    const projectLevel = assessCritical({
      now,
      locale,
      action: action("d", "p", 60),
      project: project("p", 3, { externalDeadlineAt: days(30) }),
      forecast
    });
    expect(projectLevel.tier).toBe("ordinary");
    // Once the external date is the effective one, it is external again.
    expect(
      assessCritical({
        now,
        action: action("d", "p", 60, { deadlineAt: days(3), externalDeadlineAt: days(3) }),
        project: project("p", null),
        forecast
      }).tier
    ).toBe("due_this_week_external");
    expect(
      assessCritical({
        now,
        action: action("d", "p", 60),
        project: project("p", null, { externalDeadlineAt: days(3) }),
        forecast
      }).tier
    ).toBe("due_this_week_external");
  });

  it("gives every branch the owner of the deadline it measures, never 'some external date exists'", () => {
    // A self-set project target is near; one deliverable carries a much later external date.
    const selfSet = project("p", 3);
    const unit = action("d", "p", 60, { deadlineAt: days(3), externalDeadlineAt: days(60) });
    // Latest safe start inside 24h comes from the near self-set target.
    const latest = assessCritical({
      now,
      locale,
      action: unit,
      project: selfSet,
      forecast: forecastOf({ health: "on_track", marginRatio: 0.5, latestSafeStarts: { d: minutes(60) } })
    });
    expect(latest.tier).toBe("at_risk_internal");
    // The same start against the unit's own external target is external.
    const external = assessCritical({
      now,
      locale,
      action: action("d", "p", 60, { deadlineAt: days(3), externalDeadlineAt: days(3) }),
      project: selfSet,
      forecast: forecastOf({ health: "on_track", marginRatio: 0.5, latestSafeStarts: { d: minutes(60) } })
    });
    expect(external.tier).toBe("at_risk_external");
    // A project with a self-set target near and an external date far: its health is self-set.
    const farExternal = project("p", 3, { externalDeadlineAt: days(60) });
    expect(
      assessCritical({ now, action: unit, project: farExternal, forecast: forecastOf({ health: "behind" }) }).tier
    ).toBe("behind_internal");
  });

  it("names the date the project's health is measured against in the headline, not an unrelated later external one", () => {
    const projects = [project("p", 3)];
    const actions = [action("d", "p", 60, { externalDeadlineAt: days(60) })];
    const { result } = run(projects, actions, {
      forecasts: [forecastOf({ projectId: "p", health: "behind", marginRatio: 0.5 })]
    });
    expect(result.primary?.criticalTier).toBe("behind_internal");
    expect(result.explanation).toContain("Behind project due internally");
    expect(result.explanation).not.toContain("externally");
  });

  it("names the project's forecast deadline in a health headline, not the earlier date of the selected deliverable", () => {
    // The project is behind its external date on day 5; the selected deliverable's own date is day 3.
    // Project health was measured against the project's date, so that is the one the headline names.
    const projects = [project("p", null, { externalDeadlineAt: days(5) })];
    const actions = [action("d", "p", 60, { deadlineAt: days(3), externalDeadlineAt: days(3) })];
    const { result } = run(projects, actions, {
      forecasts: [forecastOf({ projectId: "p", health: "behind", marginRatio: 0.5 })]
    });
    expect(result.explanation).toContain(`Behind project due externally`);
    expect(result.explanation).toContain(formatHeadlineDate(days(5)));
    expect(result.explanation).not.toContain(formatHeadlineDate(days(3)));
  });

  it("names the external date in the headline when an external date this week makes the work due-this-week external", () => {
    // Self-set target in 3 days, external date in 4, on-track forecast: the tier is decided by the
    // external date, so the headline names it rather than the earlier self-set target.
    const projects = [project("p", 3, { externalDeadlineAt: days(4) })];
    const actions = [action("d", "p", 60)];
    const { result } = run(projects, actions, {
      forecasts: [forecastOf({ projectId: "p", health: "on_track", marginRatio: 0.5 })]
    });
    expect(result.primary?.criticalTier).toBe("due_this_week_external");
    expect(result.explanation).toContain("On track project due externally");
    expect(result.explanation).toContain(formatHeadlineDate(days(4)));
    expect(result.explanation).not.toContain(formatHeadlineDate(days(3)));
  });

  it("ranks due-this-week external when the unit's own target is far off but its project's external date is near", () => {
    // A deliverable's internal target is 30 days out; its project's external date is 5 days out. The
    // measured deadline is beyond the week, but the external date inside it still makes the work committed.
    const projects = [project("p", null, { externalDeadlineAt: days(5) })];
    const actions = [action("d", "p", 60, { deadlineAt: days(30) })];
    const forecast = forecastOf({ projectId: "p", health: "on_track", marginRatio: 0.5 });
    const assessed = assessCritical({ now, action: actions[0]!, project: projects[0]!, forecast });
    expect(assessed.tier).toBe("due_this_week_external");
    expect(assessed.reason).toContain("externally committed");

    const { result } = run(projects, actions, { forecasts: [forecast] });
    expect(result.primary?.criticalTier).toBe("due_this_week_external");
    expect(result.explanation).toContain(`due externally ${formatHeadlineDate(days(5))}`);
    expect(result.explanation).not.toContain(formatHeadlineDate(days(30)));

    // Control: with the external date also beyond the week, the same work stays ordinary.
    const far = assessCritical({
      now,
      locale,
      action: actions[0]!,
      project: project("p", null, { externalDeadlineAt: days(20) }),
      forecast
    });
    expect(far.tier).toBe("ordinary");
  });

  it("names the action's own near deadline, not the project's later date, for a self-set deadline this week", () => {
    // Project target in 20 days, the action's own in 2: the self-set bonus comes from the action's date.
    const own = run([project("p", 20)], [action("a", "p", 60, { deadlineAt: days(2) })]).result;
    expect(own.primary?.criticalTier).toBe("ordinary");
    expect(own.explanation).toContain(`due internally ${formatHeadlineDate(days(2))}`);
    expect(own.explanation).not.toContain(formatHeadlineDate(days(20)));
    // A far external date with the action's own near target: still the action's date, still internal.
    const beside = run(
      [project("p", null, { externalDeadlineAt: days(20) })],
      [action("a", "p", 60, { deadlineAt: days(2) })]
    ).result;
    expect(beside.explanation).toContain(`due internally ${formatHeadlineDate(days(2))}`);
    expect(beside.explanation).not.toContain(formatHeadlineDate(days(20)));
  });

  it("never names the forecast's end as the deadline of a focused project with no stored date", () => {
    const projects = [project("p", null)];
    const actions = [action("a", "p", 60, { deadlineAt: days(3) })];
    const schedule = planSchedule({
      now,
      horizonEnd,
      projects,
      actions,
      capacityWindows: automatic(),
      commitments: [],
      projectedDailyProtectedMinutes: 30,
      focusedProjectIds: ["p"]
    });
    expect(schedule.forecasts[0]!.internalDeadlineAt!.getTime()).toBeGreaterThan(days(100).getTime());
    const result = recommend({
      now,
      horizonEnd,
      projects,
      actions,
      planning: schedule,
      forecasts: schedule.forecasts,
      capacityWindows: automatic(),
      commitments: [],
      currentEnergy: "high",
      timezone,
      locale
    });
    expect(result.explanation).toContain(`due internally ${formatHeadlineDate(days(3))}`);
    expect(result.explanation).not.toContain(formatHeadlineDate(schedule.forecasts[0]!.internalDeadlineAt!));
    // With nothing to name, it names nothing rather than the forecast's end.
    const undated = recommend({
      now,
      horizonEnd,
      projects,
      actions: [action("a", "p", 60)],
      planning: schedule,
      forecasts: schedule.forecasts,
      capacityWindows: automatic(),
      commitments: [],
      currentEnergy: "high",
      timezone,
      locale
    });
    expect(undated.explanation).not.toContain("due internally");
  });

  it("treats a deliverable's own external date as external when its project has none", () => {
    const bare = project("p", null);
    const unit = (overrides: Partial<Action>) => action("d", "p", 60, overrides);
    const forecast = forecastOf({ health: "on_track" });
    const passed = assessCritical({
      now,
      locale,
      action: unit({ deadlineAt: days(-2), externalDeadlineAt: days(-2) }),
      project: bare,
      forecast
    });
    expect(passed.tier).toBe("overdue_external");
    const targetPassed = assessCritical({
      now,
      locale,
      action: unit({ deadlineAt: days(-2), externalDeadlineAt: days(5) }),
      project: bare,
      forecast
    });
    expect(targetPassed.tier).toBe("at_risk_external");
    const dueSoon = assessCritical({
      now,
      locale,
      action: unit({ deadlineAt: days(3), externalDeadlineAt: days(3) }),
      project: bare,
      forecast
    });
    expect(dueSoon.tier).toBe("due_this_week_external");
    // Without the deliverable's external date the same unit is self-set, as before.
    expect(assessCritical({ now, action: unit({ deadlineAt: days(-2) }), project: bare, forecast }).tier).toBe(
      "stale_date"
    );
    expect(assessCritical({ now, action: unit({ deadlineAt: days(3) }), project: bare, forecast }).tier).toBe(
      "ordinary"
    );

    // The Now lead follows the same rule: it names the external date, not a self-set one.
    const projects = [bare];
    const actions = [unit({ deadlineAt: days(-2), externalDeadlineAt: days(-2) })];
    const { result } = run(projects, actions);
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.explanation).toContain("The external deadline");
    const ahead = run(projects, [unit({ deadlineAt: days(-2), externalDeadlineAt: days(5) })]).result;
    expect(ahead.explanation).toContain("Your own target");
    expect(ahead.explanation).toContain("external deadline");
  });

  it("does not let an internal date later than the external one hide the passed commitment", () => {
    const projects = [project("masked", 10, { externalDeadlineAt: days(-1) }), project("live", 5)];
    const actions = [action("masked-work", "masked", 120), action("live-work", "live", 120)];
    const { result, schedule } = run(projects, actions);
    const masked = schedule.forecasts.find((item) => item.projectId === "masked")!;
    // The plan runs to the external date itself, never to the internal one — and not to external less
    // the buffer either, which belongs only to a derived date (see the boundary test below).
    expect(masked.internalDeadlineAt?.getTime()).toBe(days(-1).getTime());
    expect(masked.overdue).toBe(true);
    expect(masked.proposal?.deadlineOwner).toBe("external");
    expect(masked.reasons[0]).toContain("later than the externally committed date");
    expect(result.primary?.action.id).toBe("masked-work");
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.primary?.criticalReason).toContain("renegotiate it or record the outcome");
  });

  it("keeps a typed internal date inside the submission buffer and never calls it overdue", () => {
    // External in 30 minutes, internal typed 15 minutes out: inside the 60-minute buffer a derived date
    // would subtract. Clamping the typed date to external-less-buffer put it 30 minutes in the past and
    // ranked a project that is not yet due as overdue_external; the typed date must stand as typed.
    const externalDeadlineAt = new Date(now.getTime() + 30 * MINUTE_MS);
    const internalDeadlineAt = new Date(now.getTime() + 15 * MINUTE_MS);
    const projects = [project("tight", null, { externalDeadlineAt, internalDeadlineAt }), project("live", 5)];
    const actions = [action("tight-work", "tight", 120), action("live-work", "live", 120)];
    const { result, schedule } = run(projects, actions);
    const tight = schedule.forecasts.find((item) => item.projectId === "tight")!;
    expect(tight.internalDeadlineAt?.getTime()).toBe(internalDeadlineAt.getTime());
    expect(tight.overdue).toBe(false);
    expect(tight.reasons.some((reason) => reason.includes("later than the externally committed date"))).toBe(false);
    const tightPrimary = result.primary?.action.id === "tight-work" ? result.primary : undefined;
    expect(tightPrimary?.criticalTier).not.toBe("overdue_external");
  });

  it("treats a unit in unplacedUnitIds as pressing at maximum, even when latestSafeStarts holds null for it", () => {
    // forecast-reservation: `unplacedUnitIds` means the unit's expected minutes could not all be
    // reserved before the deadline, so every reader presses on it as though its latest safe start
    // were now, whatever `latestSafeStarts` itself holds for that id.
    const assessment = assessCritical({
      now,
      locale,
      action: action("a", "p", 60),
      project: project("p", 90),
      forecast: forecastOf({
        health: "on_track",
        marginRatio: 0.5,
        latestSafeStarts: { a: null },
        unplacedUnitIds: ["a"]
      })
    });
    expect(assessment.tier).toBe("at_risk_internal");
    expect(assessment.reason).toContain("The latest safe start is");
    expect(assessment.reason).toContain(formatDate(now, undefined, locale));
  });

  it("leaves an ordinary unit unaffected when unplacedUnitIds is absent (a result stored before this field existed)", () => {
    const assessment = assessCritical({
      now,
      locale,
      action: action("a", "p", 60),
      project: project("p", 90),
      forecast: forecastOf({ health: "on_track", marginRatio: 0.5, latestSafeStarts: { a: null } })
    });
    expect(assessment.tier).toBe("ordinary");
  });

  it("ranks a passed external date overdue even when the forecast reports a future internal one", () => {
    const assessment = assessCritical({
      now,
      locale,
      action: action("a", "p", 60),
      project: project("p", 10, { externalDeadlineAt: days(-1) }),
      forecast: forecastOf({ health: "on_track", overdue: false, internalDeadlineAt: days(10) })
    });
    expect(assessment.tier).toBe("overdue_external");
    expect(assessment.rank).toBe(rankOf("overdue_external"));
    expect(assessment.reason).toContain("renegotiate it or record the outcome");
  });

  it("proposes no date when the remaining work does not fit anywhere in the horizon", () => {
    const projects = [project("slipped", -3)];
    const actions = [action("mountain", "slipped", 400_000, { maximumSessionMinutes: 600 })];
    const { schedule } = run(projects, actions);
    const proposal = schedule.forecasts.find((item) => item.projectId === "slipped")!.proposal!;
    expect(proposal.earliestFeasibleAt).toBeNull();
    expect(proposal.reason).toContain("does not fit anywhere");
  });

  it("proposes the earliest instant that displaces nobody: later when a live deadline has reserved the week", () => {
    const projects = [project("slipped", -3)];
    const alone = run(projects, [action("slipped-work", "slipped", 300)]).schedule;
    const crowded = run(
      [project("live", 3), ...projects],
      [action("live-work", "live", 1_800), action("slipped-work", "slipped", 300)]
    ).schedule;
    const aloneDate = alone.forecasts.find((item) => item.projectId === "slipped")!.proposal!.earliestFeasibleAt!;
    const crowdedDate = crowded.forecasts.find((item) => item.projectId === "slipped")!.proposal!.earliestFeasibleAt!;
    expect(crowdedDate.getTime()).toBeGreaterThan(aloneDate.getTime());
  });

  it("gives competing overdue projects joint dates that are feasible together, which their solo dates are not", () => {
    const projects = [project("a", -3), project("b", -2)];
    const actions = [action("a-work", "a", 600), action("b-work", "b", 600)];
    const { schedule } = run(projects, actions);
    const proposalOf = (id: string) => schedule.forecasts.find((item) => item.projectId === id)!.proposal!;
    const a = proposalOf("a");
    const b = proposalOf("b");
    // Alone, each fits the same free minutes, so the solo dates coincide: they count the capacity twice.
    expect(a.earliestFeasibleAt!.getTime()).toBe(b.earliestFeasibleAt!.getTime());
    const joint = [a, b].map((item) => item.jointEarliestFeasibleAt!);
    expect(Math.max(...joint.map((date) => date.getTime()))).toBeGreaterThan(a.earliestFeasibleAt!.getTime());
    const move = (dates: Date[]) =>
      planSchedule({
        now,
        horizonEnd,
        projects: [
          project("a", -3, { internalDeadlineAt: dates[0]! }),
          project("b", -2, { internalDeadlineAt: dates[1]! })
        ],
        actions,
        capacityWindows: automatic(),
        commitments: [],
        projectedDailyProtectedMinutes: 30
      }).forecasts;
    for (const forecast of move(joint)) {
      expect(forecast.overdue, forecast.projectId).toBe(false);
      expect(forecast.health, forecast.projectId).not.toBe("behind");
    }
    // The solo dates, saved together, leave at least one of them behind.
    expect(move([a.earliestFeasibleAt!, b.earliestFeasibleAt!]).some((item) => item.health === "behind")).toBe(true);
  });
});

/** Item 1: a deliverable's own deadline must clear the same ladder an action's does. */
function deliverableProjection(overrides: Partial<DeliverableProjection> = {}): DeliverableProjection {
  return {
    id: "assessment-2",
    projectId: "p",
    title: "Assessment 2",
    status: "in_progress",
    approved: true,
    remainingMinutes: 120,
    minimumUsefulSessionMinutes: 20,
    partiallyBlocked: false,
    hasOpenBlockers: false,
    dependenciesSatisfied: true,
    incompletePrerequisites: [],
    uncertainty: "some",
    importance: 5,
    consequence: 5,
    executionOptions: [],
    hasSteps: true,
    ...overrides
  };
}

describe("deliverable deadline ladder", () => {
  it("does not let a deliverable's internal date later than its external one hide the passed commitment", () => {
    const external = project("p", null, { externalDeadlineAt: days(-1) });
    const deliverable = deliverableProjection({
      externalDeadlineAt: days(-1).toISOString(),
      internalDeadlineAt: days(10).toISOString()
    });
    const [unit] = deliverableForecastUnits([deliverable]);
    expect(unit?.deadlineAt?.getTime()).toBe(days(-1).getTime());
    const assessment = assessCritical({
      now,
      locale,
      action: unit!,
      project: external,
      forecast: forecastOf({ projectId: "p", health: "on_track", overdue: false })
    });
    expect(assessment.tier).toBe("overdue_external");
    expect(assessment.reason).toContain("renegotiate it or record the outcome");
  });

  it("puts a deliverable's own overdue self-set date in the stale-date tier when nothing external governs it", () => {
    const undated = project("p", null);
    const deliverable = deliverableProjection({ internalDeadlineAt: days(-2).toISOString() });
    const [unit] = deliverableForecastUnits([deliverable]);
    expect(unit?.deadlineAt?.getTime()).toBe(days(-2).getTime());
    const assessment = assessCritical({
      now,
      locale,
      action: unit!,
      project: undated,
      forecast: forecastOf({ projectId: "p", health: "on_track", overdue: false })
    });
    expect(assessment.tier).toBe("stale_date");
    expect(assessment.reason).toContain("self-set date has lapsed");
  });

  it("takes the nearer of a deliverable's two future deadlines as its effective deadline for urgency", () => {
    const owner = project("p", null, { externalDeadlineAt: days(20) });
    const deliverable = deliverableProjection({
      internalDeadlineAt: days(2).toISOString(),
      externalDeadlineAt: days(20).toISOString()
    });
    const [unit] = deliverableForecastUnits([deliverable]);
    expect(unit?.deadlineAt?.getTime()).toBe(days(2).getTime());
    expect(effectiveDeadline({ action: unit!, project: owner, forecast: undefined })?.getTime()).toBe(
      days(2).getTime()
    );
  });
});

describe("session minutes", () => {
  it("reports focused minutes alongside the wall-clock minutes they occupy", () => {
    const { result } = run([project("p", 5)], [action("a", "p", 600, { maximumSessionMinutes: 90 })]);
    const primary = result.primary!;
    expect(primary.recommendedMinutes).toBe(90);
    expect(primary.usableFraction).toBe(0.75);
    expect(primary.recommendedWallClockMinutes).toBe(120);
    expect(result.explanation).toContain("90 focused minutes (120 by the clock)");
  });

  it("never reports more wall-clock minutes than remain before the boundary", () => {
    const capacity: CapacityWindow[] = [
      { id: "w", startsAt: now, endsAt: minutes(60), energy: "high", usableFraction: 0.5, contexts: [] }
    ];
    const { result } = run([project("p", 5)], [action("a", "p", 600, { minimumSessionMinutes: 10 })], {}, capacity);
    expect(result.primary?.recommendedMinutes).toBe(30);
    expect(result.primary?.recommendedWallClockMinutes).toBe(60);
    expect(result.primary?.sessionBoundary).toEqual(minutes(60));
  });
});

describe("explanation wording", () => {
  it("says a passed external deadline has passed instead of calling it due", () => {
    const projects = [project("missed", -1, { externalDeadlineAt: days(-1) })];
    const actions = [action("missed-work", "missed", 120)];
    const { result } = run(projects, actions);
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.explanation).toMatch(/^The external deadline \(.+\) has passed;/);
    expect(result.explanation).not.toContain("due externally");
  });

  it("adds the unmeasured effort to a passed deadline whose forecast is unknown", () => {
    const projects = [project("course", null, { externalDeadlineAt: days(-2) })];
    const actions = [action("unit", "course", 60)];
    const { result } = run(projects, actions, {}, automatic(), [{ projectId: "course", title: "unit" }]);
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.explanation).toMatch(
      /^The external deadline \(.+\) has passed and the remaining effort is not yet measured;/
    );
    expect(result.explanation).not.toContain("Unknown project");
  });

  it("states an unmeasured forecast as such rather than as an unknown project", () => {
    const projects = [project("course", null, { externalDeadlineAt: days(3) })];
    const actions = [action("unit", "course", 60)];
    const { result } = run(projects, actions, {}, automatic(), [{ projectId: "course", title: "unit" }]);
    expect(result.primary?.criticalTier).toBe("due_this_week_external");
    expect(result.explanation).toMatch(/^Project due externally .+, remaining effort not yet measured;/);
    expect(result.explanation).not.toContain("Unknown project");
  });

  it("calls an exact tie between siblings a tie, not a lead by identifier", () => {
    const projects = [project("p", 40)];
    const actions = [action("a", "p", 60), action("b", "p", 60)];
    const { result } = run(projects, actions);
    expect(result.primary?.action.id).toBe("a");
    expect(result.why.whyNot?.decidingFactor).toBe("identifier");
    expect(result.explanation).toContain("It ties with b on every ranking factor; either could go first.");
    expect(result.explanation).not.toContain("tie-break");
  });

  it("breaks an exact deadline-tier tie in favour of the action recently worked on", () => {
    // Two sibling actions on one overdue-external project, tied on every ranking factor except
    // which one you have actually touched recently.
    const projects = [project("p", null, { externalDeadlineAt: days(-1) })];
    // "a" sorts before "b" by identifier, so without recent work it would win the tie anyway —
    // make "b" the one recently worked so the test cannot pass by coincidence.
    const actions = [action("a", "p", 60), action("b", "p", 60, { lastWorkedAt: minutes(-120) })];
    const { result } = run(projects, actions);
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.primary?.action.id).toBe("b");
    expect(result.why.whyNot?.decidingFactor).toBe("momentum");
    expect(result.explanation).toContain("It leads a because it is already underway.");
  });

  it("breaks an exact deadline-tier tie in favour of the project recently worked on", () => {
    // Two separate overdue-external projects tied on everything else — the report this fixed: two
    // College assessments sharing one external deadline, distinguishable only by which one is underway.
    const projects = [
      project("p-recent", null, { externalDeadlineAt: days(-1), lastWorkedAt: minutes(-120) }),
      project("p-stale", null, { externalDeadlineAt: days(-1) })
    ];
    const actions = [action("a", "p-stale", 60), action("b", "p-recent", 60)];
    const { result } = run(projects, actions);
    expect(result.primary?.criticalTier).toBe("overdue_external");
    expect(result.primary?.action.id).toBe("b");
    expect(result.why.whyNot?.decidingFactor).toBe("momentum");
  });
});

describe("contrastive explanation", () => {
  it("names the chosen tier, the runner-up and the comparison that decided it", () => {
    const projects = [project("urgent", 3, { externalDeadlineAt: days(4) }), project("calm", 40)];
    const actions = [action("urgent-work", "urgent", 1_800), action("calm-work", "calm", 60)];
    const { result } = run(projects, actions);
    expect(result.why.because?.targetId).toBe("urgent-work");
    expect(result.why.because?.tier).toBe(result.primary?.criticalTier);
    expect(result.why.because?.tierLabel).toBe(CRITICAL_TIER_LABELS[result.primary!.criticalTier]);
    expect(result.why.whyNot?.targetId).toBe("calm-work");
    expect(result.why.whyNot?.decidingFactor).toBe("tier");
    expect(result.explanation).toContain("It leads calm-work because");
  });

  it("finds the deciding factor inside a tier", () => {
    // A self-set deadline this week is no longer its own tier (it is `ordinary` with a score bonus),
    // so this uses an external deadline — still a real critical tier — to keep both candidates tied
    // on tier and exercise the in-tier consequence tie-break.
    const projects = [
      project("a", null, { externalDeadlineAt: days(3), consequence: 5 }),
      project("b", null, { externalDeadlineAt: days(3), consequence: 2 })
    ];
    const actions = [action("a-work", "a", 60, { consequence: 5 }), action("b-work", "b", 60, { consequence: 2 })];
    const { result } = run(projects, actions);
    expect(result.primary?.action.id).toBe("a-work");
    expect(result.primary?.criticalTier).toBe("due_this_week_external");
    expect(result.why.whyNot?.decidingFactor).toBe("consequence");
  });

  it("says what would change the primary, and only that", () => {
    const projects = [project("high", 3, { consequence: 5 }), project("low", 3)];
    const actions = [
      action("high-work", "high", 60, { energy: "high", consequence: 5 }),
      action("low-work", "low", 60, { energy: "low" })
    ];
    const { result } = run(projects, actions, { currentEnergy: "low" });
    expect(result.primary?.action.id).toBe("low-work");
    const energy = result.why.wouldChangeIf.find((item) => item.condition === "energy_high");
    expect(energy?.thenPrimary?.targetId).toBe("high-work");
    expect(energy?.description).toBe("if your energy were high");
    const same = run(projects, actions, { currentEnergy: "high" }).result;
    expect(same.why.wouldChangeIf.map((item) => item.condition)).not.toContain("energy_high");
  });

  it("asks what being at the missing location would change", () => {
    const definitions = [
      conditionDefinitionSchema.parse({ id: "campus", name: "campus", kind: "location" }),
      conditionDefinitionSchema.parse({ id: "home", name: "home", kind: "location" })
    ];
    const projects = [project("lab", 3, { consequence: 5 }), project("desk", 3)];
    const actions = [
      action("lab-work", "lab", 60, { consequence: 5, requirementPathways: [{ id: "p", contextIds: ["campus"] }] }),
      action("desk-work", "desk", 60)
    ];
    const { result } = run(projects, actions, {
      conditionDefinitions: definitions,
      currentSituation: currentSituationSchema.parse({ locationId: "home", locationSetAt: now.toISOString() })
    });
    expect(result.primary?.action.id).toBe("desk-work");
    const location = result.why.wouldChangeIf.find((item) => item.condition === "at_location");
    expect(location?.description).toBe("if you were at campus");
    expect(location?.thenPrimary?.targetId).toBe("lab-work");
  });
});

describe("nothing fits, stated as what would resolve it", () => {
  it("turns an unanswered context into a question carrying the candidate that would lead", () => {
    const definitions = [conditionDefinitionSchema.parse({ id: "home", name: "home", kind: "location" })];
    const projects = [project("p", 3)];
    const actions = [action("a", "p", 60, { requirementPathways: [{ id: "p", contextIds: ["home"] }] })];
    const { result } = run(projects, actions, {
      conditionDefinitions: definitions,
      currentSituation: currentSituationSchema.parse({})
    });
    expect(result.primary).toBeNull();
    expect(result.noFit).toEqual({
      kind: "answer",
      question: "Are you at home?",
      contextIds: ["home"],
      candidate: { targetId: "a", title: "a", recommendedMinutes: 60 }
    });
    expect(result.explanation).toContain("If yes, a would lead for 60 minutes.");
  });

  it("names the daily horizon as the boundary and the first thing that fits after it", () => {
    const projects = [project("p", 5)];
    const actions = [action("a", "p", 120)];
    const { result } = run(projects, actions, { dailyHorizonEnd: minutes(15) });
    expect(result.primary).toBeNull();
    // Structurally: the only thing wrong with the candidate is the window, and it says so.
    expect(result.candidates[0]?.windowBound).toBe(true);
    expect(result.candidates[0]?.recommendedMinutes).toBeNull();
    const noFit = result.noFit;
    expect(noFit?.kind).toBe("boundary");
    if (noFit?.kind !== "boundary") throw new Error("expected boundary");
    expect(noFit.boundaryKind).toBe("daily_horizon");
    expect(noFit.boundaryAt).toEqual(minutes(15));
    // Capacity between the horizon and midnight is real but not plannable; the next fit is tomorrow.
    expect(noFit.nextFit?.targetId).toBe("a");
    // 07:00 the next local day in the seed zone, not the 17:15–22:00 capacity still open tonight.
    expect(noFit.nextFit!.at).toEqual(new Date("2026-08-07T21:00:00.000Z"));
    expect(result.headline).toBe("Nothing fits before the day ends at 5:15 pm");
    expect(result.explanation).toContain("The next thing that fits is a at");
  });

  it("names a commitment as the boundary when it is what closes the window", () => {
    const projects = [project("p", 5)];
    const actions = [action("a", "p", 120)];
    const commitments = [{ id: "c", title: "Dinner", startsAt: minutes(20), endsAt: minutes(80) }];
    const { result } = run(projects, actions, { commitments });
    const noFit = result.noFit;
    if (noFit?.kind !== "boundary") throw new Error(`expected boundary, got ${noFit?.kind}`);
    expect(noFit.boundaryKind).toBe("commitment");
    expect(noFit.boundaryTitle).toBe("Dinner");
    expect(noFit.boundaryAt).toEqual(minutes(20));
    expect(noFit.nextFit?.at).toEqual(minutes(80));
    expect(result.headline).toBe("Nothing fits before Dinner at 5:20 pm");
  });

  describe("where a boundary ends", () => {
    // Two protected windows with a 4-minute gap between them. Sleep ids are used because they hold
    // capacity without being resolved as the protected commitment, so the boundary path is reached.
    const gapped = [
      { id: "sleep:a", title: "Sleep", startsAt: minutes(-30), endsAt: minutes(60) },
      { id: "sleep:b", title: "Sleep", startsAt: minutes(64), endsAt: minutes(120) }
    ];
    const boundaryOf = (actions: Action[]) => {
      const { result } = run([project("p", 5)], actions, { commitments: gapped, protectedCommitments: [] });
      const noFit = result.noFit;
      if (noFit?.kind !== "boundary") throw new Error(`expected boundary, got ${noFit?.kind}`);
      return { noFit, result };
    };

    it("ends at the earliest gap that fits ANY ranked candidate, not just the lead one", () => {
      const lead = action("lead", "p", 120, { minimumSessionMinutes: 30 });
      const quick = action("quick", "p", 4, { minimumSessionMinutes: 3, maximumSessionMinutes: 4, importance: 1 });
      const { noFit, result } = boundaryOf([lead, quick]);
      expect(noFit.boundaryEdge).toBe("end");
      expect(noFit.boundaryAt).toEqual(minutes(60));
      expect(noFit.nextFit?.targetId).toBe("quick");
      expect(result.explanation).toContain("protected until");
    });

    it("does not end at a gap an indivisible action cannot use", () => {
      const bulk = action("bulk", "p", 60, { minimumSessionMinutes: 3, splittable: false });
      const { noFit } = boundaryOf([bulk]);
      expect(noFit.boundaryAt).toEqual(minutes(120));
    });

    it("does not end at an opening after the action's latest start", () => {
      const late = action("late", "p", 4, {
        minimumSessionMinutes: 3,
        maximumSessionMinutes: 4,
        latestStartAt: minutes(30)
      });
      const { noFit } = boundaryOf([late]);
      expect(noFit.boundaryAt).not.toEqual(minutes(60));
    });
  });

  it("stays plain none when the work itself is the problem", () => {
    const { result } = run([project("p", 5)], [action("a", "p", 60, { dependenciesComplete: false })]);
    expect(result.noFit).toEqual({ kind: "none" });
    expect(result.headline).toBe("No suitable action fits right now");
  });
});
