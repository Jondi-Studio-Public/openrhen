import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  PlanForecastEngineError,
  classifyPlanForecastFailure,
  planForecastLeaseSeconds,
  planForecastRetryAfterFailure,
  requestPlanForecast
} from "./plan-forecast-runtime.js";

describe("planForecastRetryAfterFailure", () => {
  it("waits out every delay in the table before failing the job", () => {
    const outcomes = [1, 2, 3, 4, 5, 6].map(planForecastRetryAfterFailure);
    expect(outcomes).toEqual([
      { failed: false, delaySeconds: 1 },
      { failed: false, delaySeconds: 5 },
      { failed: false, delaySeconds: 30 },
      { failed: false, delaySeconds: 120 },
      { failed: false, delaySeconds: 600 },
      { failed: true }
    ]);
  });

  it("gives an engine outage roughly thirteen minutes before the plan fails", () => {
    let waited = 0;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const retry = planForecastRetryAfterFailure(attempts);
      if (retry.failed) break;
      waited += retry.delaySeconds;
    }
    expect(attempts).toBe(6);
    expect(waited).toBe(756);
  });
});

describe("planForecastLeaseSeconds", () => {
  it("keeps the two-minute lease for the default engine timeout", () => {
    expect(planForecastLeaseSeconds(10_000)).toBe(120);
  });

  it("outlasts a configured engine timeout by a minute", () => {
    expect(planForecastLeaseSeconds(150_000)).toBe(210);
    expect(planForecastLeaseSeconds(150_001)).toBe(211);
  });
});

describe("classifyPlanForecastFailure", () => {
  it("fails an engine rejection at once, whatever the attempt", () => {
    for (const error of [
      new PlanForecastEngineError(400, "validation_failed"),
      new PlanForecastEngineError(413, "payload_too_large"),
      new PlanForecastEngineError(500, "calculation_failed"),
      new PlanForecastEngineError(200, "invalid_response")
    ])
      expect(classifyPlanForecastFailure(error, 1)).toEqual({
        code: "plan_forecast_rejected",
        retry: { failed: true }
      });
  });

  it("retries an engine that could not answer, on the usual schedule", () => {
    for (const error of [
      new PlanForecastEngineError(null, "unreachable"),
      new PlanForecastEngineError(null, "timed out"),
      new PlanForecastEngineError(401, "unauthorised"),
      new PlanForecastEngineError(503, "")
    ])
      expect(classifyPlanForecastFailure(error, 2)).toEqual({
        code: "plan_forecast_unavailable",
        retry: { failed: false, delaySeconds: 5 }
      });
  });

  it("never exhausts a job while the engine is unavailable: it keeps retrying at the longest delay", () => {
    for (const attempts of [5, 6, 7, 40])
      expect(classifyPlanForecastFailure(new PlanForecastEngineError(null, "unreachable"), attempts)).toEqual({
        code: "plan_forecast_unavailable",
        retry: { failed: false, delaySeconds: 600 }
      });
  });

  it("never blames the engine for a failure after it answered", () => {
    expect(classifyPlanForecastFailure(new Error("deadlock detected"), 1)).toEqual({
      code: "plan_forecast_persist_failed",
      retry: { failed: false, delaySeconds: 1 }
    });
  });
});

describe("requestPlanForecast", () => {
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  };

  it("treats a body cut off after the headers as unavailable, not as an invalid response", async () => {
    const { server, url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      response.write('{"partial":');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    try {
      const error = await requestPlanForecast({ url, token: "t", timeoutMs: 5000 }, {} as never).catch((e) => e);
      expect(error).toBeInstanceOf(PlanForecastEngineError);
      expect(error).toMatchObject({ status: null, code: "unreachable", rejected: false });
    } finally {
      server.close();
    }
  });

  it("treats a fully received body that fails the schema as an invalid response", async () => {
    const { server, url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"not":"a plan"}');
    });
    try {
      const error = await requestPlanForecast({ url, token: "t", timeoutMs: 5000 }, {} as never).catch((e) => e);
      expect(error).toMatchObject({ status: 200, code: "invalid_response", rejected: true });
    } finally {
      server.close();
    }
  });
});
