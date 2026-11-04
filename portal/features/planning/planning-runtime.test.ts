import { describe, expect, it } from "vitest";
import {
  awaitingRecalculation,
  latestJobFailedAfterRun,
  outOfDatePlanWarning,
  planHealthAfterSave,
  planIsUpdating,
  retryingWithNewerState,
  planRefreshState,
  planningRuntime,
  type PlanningJobRow,
  type PlanningRunRow
} from "@/features/planning/planning-runtime";

const NOW = new Date("2026-08-13T02:00:00.000Z");
const anHourAgo = new Date("2026-08-13T01:00:00.000Z");
const inAnHour = new Date("2026-08-13T03:00:00.000Z");

function result(validUntil: Date) {
  return {
    contractVersion: "1",
    requestId: "8fe5bba7-e436-429d-8011-67467b3ec55e",
    inputVersion: "abc123",
    engineVersion: "1.2.0",
    calculatedAt: anHourAgo.toISOString(),
    validUntil: validUntil.toISOString(),
    derivedState: { sleepPlans: [], occurrences: [], routineSteps: [] },
    schedule: { forecasts: [] },
    recommendation: { candidates: [] },
    currentDirective: { kind: "none", title: "Nothing to do", recommendedMinutes: 0 },
    continuation: null
  };
}

function run(validUntil: Date): PlanningRunRow {
  return { calculated_at: anHourAgo, valid_until: validUntil, result: result(validUntil) };
}

function job(status: string, availableAt: Date, lastError: string | null = null): PlanningJobRow {
  return { status, available_at: availableAt, last_error_message: lastError };
}

describe("planningRuntime", () => {
  it("keeps a valid result current while the next boundary refresh is only scheduled", () => {
    // The worker queues the next run at the validity boundary the moment a run succeeds. That job is
    // scheduled, not in flight, and must not report the engine as updating for the whole hour.
    const state = planningRuntime(run(inAnHour), job("pending", inAnHour), job("completed", anHourAgo), NOW);
    expect(state.status).toBe("current");
    expect(state.nextAttemptAt).toBe(inAnHour.toISOString());
    expect(state.message).toBeUndefined();
  });

  it("reports pending once a queued job is actually due", () => {
    const state = planningRuntime(run(anHourAgo), job("pending", anHourAgo), undefined, NOW);
    expect(state.status).toBe("pending");
  });

  it("reports pending while a job is running regardless of its scheduled time", () => {
    const state = planningRuntime(run(anHourAgo), job("running", inAnHour), undefined, NOW);
    expect(state.status).toBe("pending");
  });

  it("reports stale when the result expired and nothing is queued", () => {
    const state = planningRuntime(run(anHourAgo), undefined, job("completed", anHourAgo), NOW);
    expect(state.status).toBe("stale");
  });

  it("reports failed with the worker's error when the last attempt failed and nothing is queued", () => {
    const state = planningRuntime(run(anHourAgo), undefined, job("failed", anHourAgo, "fetch failed"), NOW);
    expect(state.status).toBe("failed");
    expect(state.message).toBe("fetch failed");
  });

  it("prefers in-flight work over an older terminal failure", () => {
    const state = planningRuntime(
      run(anHourAgo),
      job("retrying", anHourAgo, "fetch failed"),
      job("failed", anHourAgo, "fetch failed"),
      NOW
    );
    expect(state.status).toBe("pending");
    expect(state.message).toBe("fetch failed");
  });

  it("reports unavailable when no run has ever succeeded", () => {
    const state = planningRuntime(undefined, undefined, undefined, NOW);
    expect(state.status).toBe("unavailable");
    expect(state.message).toBe("The Plan and Forecast Engine has not produced a result yet.");
  });

  it("reports a valid plan as current while still awaiting the run that will replace it", () => {
    // The case the whole freshness path exists for: a mutation enqueued a job against newer state
    // and answered with the previous run. Nothing is wrong, so no banner — but the page must know it
    // is behind, or "complete an action, see the next directive" waits for the next tick.
    const due = { ...job("pending", anHourAgo), state_captured_at: NOW };
    const state = planningRuntime(run(inAnHour), due, undefined, NOW);
    expect(state.status).toBe("current");
    expect(state.awaitingRecalculation).toBe(true);
    expect(state.message).toBeUndefined();
  });

  it("judges a pending update by the newest due job, not by the oldest queue entry it was handed", () => {
    // An old job still running on a snapshot the run already covers is the oldest entry; a newer one
    // holds state the run has not seen. Only the newer one says an update is coming.
    const oldest = { ...job("running", anHourAgo), state_captured_at: new Date(anHourAgo.getTime() - 60_000) };
    const newest = { ...job("pending", anHourAgo), state_captured_at: NOW };
    expect(planningRuntime(run(inAnHour), oldest, undefined, NOW).awaitingRecalculation).toBeUndefined();
    expect(planningRuntime(run(inAnHour), oldest, undefined, NOW, newest).awaitingRecalculation).toBe(true);
  });

  it("drops a result that no longer satisfies the response contract", () => {
    const state = planningRuntime(
      { calculated_at: anHourAgo, valid_until: inAnHour, result: { contractVersion: "1" } },
      undefined,
      undefined,
      NOW
    );
    expect(state.status).toBe("unavailable");
    expect(state.result).toBeUndefined();
  });
});

describe("awaitingRecalculation", () => {
  const captured = (availableAt: Date, stateCapturedAt: Date | null, status = "pending"): PlanningJobRow => ({
    ...job(status, availableAt),
    state_captured_at: stateCapturedAt
  });

  it("is false while the only queued job is a future validity boundary", () => {
    // The chained boundary job always carries a snapshot newer than the run it came from, so
    // counting a merely scheduled one would leave a healthy plan reporting itself behind all hour.
    expect(awaitingRecalculation(run(inAnHour), captured(inAnHour, NOW), NOW)).toBe(false);
  });

  it("is true once a job holding newer state is due", () => {
    expect(awaitingRecalculation(run(inAnHour), captured(anHourAgo, NOW), NOW)).toBe(true);
  });

  it("is true while a worker is running a job holding newer state", () => {
    expect(awaitingRecalculation(run(inAnHour), captured(inAnHour, NOW, "running"), NOW)).toBe(true);
  });

  it("is false when the due job's snapshot is no newer than the run already shown", () => {
    // The run this job produced is the one on screen; there is nothing further to wait for.
    expect(awaitingRecalculation(run(inAnHour), captured(anHourAgo, anHourAgo), NOW)).toBe(false);
  });

  it("treats a due job with no recorded snapshot as newer", () => {
    // Jobs enqueued before the snapshot stamp existed. Asking again beats assuming it is current.
    expect(awaitingRecalculation(run(inAnHour), captured(anHourAgo, null), NOW)).toBe(true);
  });

  it("is false when nothing is queued at all", () => {
    expect(awaitingRecalculation(run(inAnHour), undefined, NOW)).toBe(false);
  });

  it("is true when a job is due and no run exists yet", () => {
    expect(awaitingRecalculation(undefined, captured(anHourAgo, NOW), NOW)).toBe(true);
  });
});

describe("planRefreshState", () => {
  const minutesPastBoundary = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const job = (status: string, availableAt: Date): PlanningJobRow => ({
    status,
    available_at: availableAt,
    last_error_message: null
  });

  it("is current inside the validity window, whatever the queue holds", () => {
    expect(planRefreshState(run(inAnHour), job("retrying", inAnHour), NOW)).toBe("current");
    expect(planRefreshState(run(inAnHour), undefined, NOW)).toBe("current");
  });

  it("is refreshing just past the boundary while a replacement is due or running, or nothing is queued yet", () => {
    expect(planRefreshState(run(minutesPastBoundary(1)), job("pending", minutesPastBoundary(1)), NOW)).toBe(
      "refreshing"
    );
    expect(planRefreshState(run(minutesPastBoundary(1)), job("running", minutesPastBoundary(1)), NOW)).toBe(
      "refreshing"
    );
    // The browser asks for a recalculation when nothing is queued; that is not yet a fault.
    expect(planRefreshState(run(minutesPastBoundary(2)), undefined, NOW)).toBe("refreshing");
  });

  it("is retrying while the next attempt is scheduled and the plan is not yet long out of date", () => {
    expect(planRefreshState(run(minutesPastBoundary(3)), job("retrying", inAnHour), NOW)).toBe("retrying");
  });

  it("is stalled once the plan has been out of date for ten minutes, however busy the queue looks", () => {
    expect(planRefreshState(run(minutesPastBoundary(10)), job("running", minutesPastBoundary(10)), NOW)).toBe(
      "stalled"
    );
    expect(planRefreshState(run(minutesPastBoundary(45)), job("retrying", inAnHour), NOW)).toBe("stalled");
    expect(planRefreshState(run(minutesPastBoundary(45)), undefined, NOW)).toBe("stalled");
  });

  it("is refreshing when no plan exists yet and the job that should produce one is recent", () => {
    const recent = { ...job("pending", NOW), created_at: new Date(NOW.getTime() - 2 * 60_000) };
    expect(planRefreshState(undefined, recent, NOW)).toBe("refreshing");
  });

  it("is stalled straight away when no plan exists and no job is queued to make one", () => {
    expect(planRefreshState(undefined, undefined, NOW)).toBe("stalled");
  });

  it("ages a job with no creation time off its available time when no plan exists", () => {
    expect(planRefreshState(undefined, job("pending", anHourAgo), NOW)).toBe("stalled");
  });

  it("is stalled when no plan has ever been produced and its job is ten minutes old", () => {
    const old = { ...job("pending", anHourAgo), created_at: new Date(NOW.getTime() - 30 * 60_000) };
    expect(planRefreshState(undefined, old, NOW)).toBe("stalled");
  });
});

describe("latestJobFailedAfterRun", () => {
  const finished = (status: string, createdAt: Date | null, capturedAt: Date | null = null) => ({
    status,
    created_at: createdAt,
    state_captured_at: capturedAt
  });
  const before = (date: Date) => new Date(date.getTime() - 1000);

  it("counts a failed job created after the run", () => {
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", NOW))).toBe(true);
  });

  it("ignores a failure older than the run: the run landed anyway", () => {
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", before(anHourAgo)))).toBe(false);
  });

  it("orders by stateCapturedAt, not created_at, when the job has one", () => {
    // A long command transaction: created_at (transaction start) predates the run, but the state it
    // captured was read after the run, so the failure is newer than the plan on screen.
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", before(anHourAgo), NOW))).toBe(true);
    // The converse: created late, but the state it carries is older than the run.
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", NOW, before(anHourAgo)))).toBe(false);
  });

  it("falls back to created_at only when stateCapturedAt is missing", () => {
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", NOW, null))).toBe(true);
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", before(anHourAgo), null))).toBe(false);
  });

  it("ignores jobs that finished well, or no finished job", () => {
    expect(latestJobFailedAfterRun(run(inAnHour), finished("completed", NOW))).toBe(false);
    expect(latestJobFailedAfterRun(run(inAnHour), undefined)).toBe(false);
  });

  it("counts any failure when there is no run, but not one that cannot be placed in time", () => {
    expect(latestJobFailedAfterRun(undefined, finished("failed", null))).toBe(true);
    expect(latestJobFailedAfterRun(run(inAnHour), finished("failed", null, null))).toBe(false);
  });
});

describe("retryingWithNewerState", () => {
  const retrying = (capturedAt: Date | null, status = "retrying"): PlanningJobRow => ({
    status,
    available_at: inAnHour,
    last_error_message: null,
    state_captured_at: capturedAt,
    created_at: capturedAt
  });

  it("counts a retrying job whose captured state is newer than the run", () => {
    expect(retryingWithNewerState(run(inAnHour), retrying(NOW))).toBe(true);
  });

  it("ignores an older job that failed into retrying after a newer one published the run", () => {
    expect(retryingWithNewerState(run(inAnHour), retrying(new Date(anHourAgo.getTime() - 1000)))).toBe(false);
    expect(retryingWithNewerState(run(inAnHour), retrying(anHourAgo))).toBe(false);
  });

  it("counts a retrying job when there is no run or its snapshot is unknown", () => {
    expect(retryingWithNewerState(undefined, retrying(anHourAgo))).toBe(true);
    expect(retryingWithNewerState(run(inAnHour), retrying(null))).toBe(true);
  });

  it("ignores jobs that are not retrying, and an empty queue", () => {
    expect(retryingWithNewerState(run(inAnHour), retrying(NOW, "pending"))).toBe(false);
    expect(retryingWithNewerState(run(inAnHour), retrying(NOW, "running"))).toBe(false);
    expect(retryingWithNewerState(run(inAnHour), undefined)).toBe(false);
  });
});

describe("planIsUpdating", () => {
  it("is true for a due or running job holding newer state, and for a retry holding newer state", () => {
    expect(planIsUpdating({ awaitingRecalculation: true, retryingNewerState: false })).toBe(true);
    expect(planIsUpdating({ awaitingRecalculation: false, retryingNewerState: true })).toBe(true);
  });

  it("is false for the scheduled validity-boundary job, a stale retry, an empty queue, or an older status", () => {
    expect(planIsUpdating({ awaitingRecalculation: false, retryingNewerState: false })).toBe(false);
    expect(planIsUpdating({ awaitingRecalculation: false })).toBe(false);
  });
});

describe("planHealthAfterSave", () => {
  const health = { refresh: "stalled", graceEndsAt: "2026-08-13T04:00:00.000Z", unreachable: true } as const;

  it("marks the plan updating and clears an earlier failure, keeping every other field", () => {
    expect(planHealthAfterSave({ ...health, updating: false, latestJobFailed: true })).toEqual({
      ...health,
      updating: true,
      latestJobFailed: false
    });
  });

  it("leaves no health to override before the first poll", () => {
    expect(planHealthAfterSave(null)).toBeNull();
  });
});

describe("outOfDatePlanWarning", () => {
  const stalled = { refresh: "stalled", graceEndsAt: null, unreachable: false } as const;
  const warn = (graceEndsAt: string | null) =>
    outOfDatePlanWarning({
      health: { ...stalled, graceEndsAt },
      validUntil: "2026-08-12T22:00:00.000Z",
      now: NOW,
      format: () => "2:00 pm"
    });

  it("says once where Start is off: everywhere, once the grace has run out", () => {
    const text = warn(null);
    expect(text).toBe(
      "The plan has been out of date for 4 hours and is not refreshing, so the planning worker may be down. Start is off everywhere until it refreshes."
    );
  });

  it("says Start is off on this page only while the handheld and API still accept it", () => {
    expect(warn("2026-08-13T04:00:00.000Z")).toMatch(
      /may be down\. Start is off on this page; the handheld and API still accept Start until 2:00 pm\.$/
    );
  });
});
