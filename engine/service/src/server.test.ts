import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  PLAN_FORECAST_MAX_HORIZON_DAYS,
  planForecastRequestSchema,
  portalStateSchema
} from "@openrhen/contracts";
import { calculatePlanAndForecast } from "@openrhen/engine-core";
import { handleRequest } from "./server.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () =>
  Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
);

function fakeResponse() {
  const state = { status: 0, body: "", destroyed: false };
  const response = {
    headersSent: false,
    statusCode: 0,
    on: () => response,
    writeHead(status: number) {
      state.status = status;
      response.headersSent = true;
      return response;
    },
    end(body?: string) {
      state.body = body ?? "";
    },
    destroy() {
      state.destroyed = true;
    }
  };
  return { state, response: response as unknown as ServerResponse };
}

describe("Plan and Forecast service malformed requests", () => {
  const config = { token: "test-token", maxPayloadBytes: 1024 };

  it("answers 404 for a request target that is not a valid URL", async () => {
    for (const url of ["//", "///"]) {
      const { state, response } = fakeResponse();
      const request = { url, method: "GET", headers: {} } as unknown as IncomingMessage;
      await expect(handleRequest(request, response, config)).resolves.toBeUndefined();
      expect(state.status).toBe(404);
    }
  });

  it("answers 400 when the request stream errors mid-body", async () => {
    const { state, response } = fakeResponse();
    const request = Object.assign(
      new Readable({
        read() {
          this.push("{");
          this.destroy(new Error("aborted"));
        }
      }),
      { url: "/v1/plan-and-forecast", method: "POST", headers: { authorization: "Bearer test-token" } }
    ) as unknown as IncomingMessage;
    await expect(handleRequest(request, response, config)).resolves.toBeUndefined();
    expect(state.status).toBe(400);
  });
});

describe("Plan and Forecast service boundary", () => {
  it("exposes health without planning data", async () => {
    const url = await start();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("requires a bearer token for calculations", async () => {
    const url = await start();
    const response = await fetch(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(401);
  });

  it("rejects malformed authenticated requests", async () => {
    const url = await start();
    const response = await fetch(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("rejects unsupported contract versions", async () => {
    const url = await start();
    const response = await fetch(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ contractVersion: "2" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("rejects oversized requests without echoing their contents", async () => {
    const url = await start(32);
    const secretMarker = "must-not-be-returned";
    const response = await fetch(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ padding: secretMarker.repeat(10) })
    });
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(secretMarker);
  });

  it("rejects a horizon past the cap and accepts one at it", async () => {
    const now = new Date("2026-08-11T01:00:00.000Z");
    const url = await start(5 * 1024 * 1024);
    const post = (days: number) =>
      fetch(`${url}/v1/plan-and-forecast`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
          requestId: "00000000-0000-4000-8000-000000000002",
          inputVersion: "horizon-fixture",
          calculatedAt: now.toISOString(),
          horizonEnd: new Date(now.getTime() + days * 86_400_000).toISOString(),
          state: createContractState(now)
        })
      });
    const tooLong = await post(PLAN_FORECAST_MAX_HORIZON_DAYS + 1);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain("horizonEnd");
    expect((await post(PLAN_FORECAST_MAX_HORIZON_DAYS)).status).toBe(200);
  });

  it("returns the same canonical result as the pure engine", async () => {
    const now = new Date("2026-08-11T01:00:00.000Z");
    const request = planForecastRequestSchema.parse({
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      requestId: "00000000-0000-4000-8000-000000000001",
      inputVersion: "deterministic-fixture",
      calculatedAt: now.toISOString(),
      horizonEnd: new Date(now.getTime() + 180 * 86_400_000).toISOString(),
      state: createContractState(now)
    });
    const expected = JSON.stringify(calculatePlanAndForecast(request));
    const url = await start(5 * 1024 * 1024);
    const response = await fetch(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  });
});

function createContractState(now: Date) {
  return portalStateSchema.parse({
    settings: {
      timezone: "Australia/Sydney",
      planningHorizonEnd: "22:00",
      defaultUsableFraction: 0.85,
      defaultSetupBufferMinutes: 0,
      defaultTransitionBufferMinutes: 0,
      submissionBufferMinutes: 0,
      submissionBufferPercent: 0,
      energyMeanings: { high: "high", medium: "medium", low: "low", recovery: "recovery" },
      estimateBucketsMinutes: [15, 30, 60],
      conditionCatalog: ["home"],
      preferredBedtime: "23:00",
      preferredWakeTime: "07:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 420,
      maxAwakeHours: 16
    },
    areas: [],
    outcomes: [],
    projects: [],
    actions: [],
    commitments: [],
    routineSteps: [],
    routinePresets: [],
    routineInstances: [],
    occurrences: [],
    sleepPlans: [],
    captures: [],
    completedToday: [],
    assertedConditions: ["home"],
    currentEnergy: "medium",
    horizonEnd: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    activeSession: null
  });
}
async function start(maxPayloadBytes = 1024) {
  const server = createServer(
    (request, response) => void handleRequest(request, response, { token: "test-token", maxPayloadBytes })
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}
