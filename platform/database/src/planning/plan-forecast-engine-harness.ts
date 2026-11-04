import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type postgres from "postgres";
import type { PlanForecastRequest } from "@openrhen/contracts";
import { buildPlanForecastRequest, type PlanForecastServiceConfig } from "./plan-forecast-runtime.js";

/**
 * Test-only fixture shared by the plan-forecast integration suites that drive `processPlanForecastJob`
 * against a stand-in Plan and Forecast Engine. `processPlanForecastJob` reaches the engine over HTTP
 * (`requestPlanForecast`), so proving an engine call was — or was not — made means counting real
 * requests against a real server, not inspecting a mock function.
 */
export interface StandInEngine {
  config: PlanForecastServiceConfig;
  /** Requests received since the last `reset()`. */
  readonly callCount: number;
  /** The `requestId` the engine answered each `inputVersion` with, so a test can tell whose run persisted. */
  requestIdFor(inputVersion: string): string | undefined;
  /**
   * `past` (the default) means a completed run never chains a `validity_boundary` follow-up job;
   * `future` means it does.
   */
  validUntil: "past" | "future";
  /**
   * Hold the request carrying `inputVersion` until `release()` is called. The returned promise
   * resolves once that request has reached the engine, so a test can act while the call is in flight.
   */
  holdRequest(inputVersion: string): { reached: Promise<void>; release: () => void };
  /** Answer the request carrying `inputVersion` with a 400 `invalid_request`, a terminal rejection. */
  rejectRequest(inputVersion: string): void;
  /** Clear counters, answers and any held request (releasing it, so no await leaks into the next test). */
  reset(): void;
  close(): Promise<void>;
}

export async function startStandInEngine(timeoutMs = 5_000): Promise<StandInEngine> {
  let callCount = 0;
  const requestIdByInputVersion = new Map<string, string>();
  const rejected = new Set<string>();
  let held: { inputVersion: string; gate: Promise<void>; release: () => void; onReached: () => void } | null = null;

  const engine = {
    validUntil: "past" as "past" | "future",
    get callCount() {
      return callCount;
    }
  };

  /** A minimal, schema-valid `PlanForecastResponse`. */
  const responseBody = (inputVersion: string, calculatedAt: string) => {
    const requestId = crypto.randomUUID();
    requestIdByInputVersion.set(inputVersion, requestId);
    return {
      contractVersion: "1",
      requestId,
      inputVersion,
      engineVersion: "test-engine",
      // The real engine plans as of the request's `calculatedAt` and echoes it back, and persistence
      // orders results by it, so the stand-in must not stamp its own clock here.
      calculatedAt,
      validUntil:
        engine.validUntil === "future"
          ? new Date(Date.now() + 10 * 60_000).toISOString()
          : new Date(Date.now() - 60_000).toISOString(),
      derivedState: {
        sleepPlans: [],
        occurrences: [],
        routineSteps: [],
        commitmentRepeats: []
      },
      schedule: {},
      recommendation: {},
      currentDirective: { kind: "none", title: "No suitable action", recommendedMinutes: 0 },
      upcomingDirectives: [],
      continuation: null
    };
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        callCount += 1;
        const { inputVersion, calculatedAt } = JSON.parse(body) as { inputVersion: string; calculatedAt: string };
        if (held && held.inputVersion === inputVersion) {
          held.onReached();
          await held.gate;
        }
        if (rejected.has(inputVersion)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "invalid_request" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody(inputVersion, calculatedAt)));
      })();
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as AddressInfo).port;

  return Object.assign(engine, {
    config: { url: `http://127.0.0.1:${port}`, token: "test-token", timeoutMs },
    requestIdFor: (inputVersion: string) => requestIdByInputVersion.get(inputVersion),
    holdRequest(inputVersion: string) {
      let release!: () => void;
      const gate = new Promise<void>((resolvePromise) => (release = resolvePromise));
      let onReached!: () => void;
      const reached = new Promise<void>((resolvePromise) => (onReached = resolvePromise));
      held = { inputVersion, gate, release, onReached };
      return { reached, release };
    },
    rejectRequest: (inputVersion: string) => void rejected.add(inputVersion),
    reset() {
      held?.release();
      held = null;
      rejected.clear();
      callCount = 0;
      requestIdByInputVersion.clear();
      engine.validUntil = "past";
    },
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  });
}

export const jobStatusOf = async (sql: postgres.Sql, id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id=${id}`)[0]?.status ?? null;

/** The smallest state `portalStateSchema` accepts: every array left empty where the schema allows it,
 * every required scalar filled with an inert value. Built through `buildPlanForecastRequest` itself so
 * the resulting `PlanForecastRequest` is genuinely schema-valid — the same object `claimPlanForecastJob`
 * will parse — rather than a hand-shaped approximation of one. */
export async function minimalPlanForecastRequest(at: Date): Promise<PlanForecastRequest> {
  const state = {
    settings: {
      timezone: "UTC",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 10,
      defaultTransitionBufferMinutes: 10,
      submissionBufferMinutes: 60,
      submissionBufferPercent: 0.1,
      energyMeanings: { high: "High", medium: "Medium", low: "Low", recovery: "Recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      preferredBedtime: "22:30",
      preferredWakeTime: "06:30",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 17
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: [],
    currentEnergy: "medium",
    horizonEnd: new Date(at.getTime() + 12 * 3_600_000).toISOString(),
    activeSession: null
  };
  return buildPlanForecastRequest(state, at);
}
