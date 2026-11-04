import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { calculatePlanAndForecast } from "@openrhen/engine-core";
import { planForecastRequestSchema } from "@openrhen/contracts";
import { DEFAULT_FIXTURE_DIR, FIXTURES, checkPortable, checkShape, runAll } from "../conformance/run.mjs";
import { handleRequest } from "./server.js";

const run = promisify(execFile);
const runner = join(import.meta.dirname, "../conformance/run.mjs");
const servers: Server[] = [];
afterEach(async () =>
  Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
);

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}

const realEngine = () =>
  listen(
    (request, response) =>
      void handleRequest(request, response, { token: "conformance-token", maxPayloadBytes: 5_000_000 })
  );

function readFixture(name: string) {
  return JSON.parse(readFileSync(join(DEFAULT_FIXTURE_DIR, name), "utf8")) as {
    request: unknown;
    expect: Record<string, unknown>;
  };
}

describe("conformance runner against the real engine service", { timeout: 60_000 }, () => {
  it("passes every listed fixture through the command line and never prints the token", async () => {
    const url = await realEngine();
    const { stdout } = await run(process.execPath, [runner, "--url", url, "--token-env", "CONFORMANCE_TOKEN"], {
      env: { ...process.env, CONFORMANCE_TOKEN: "conformance-token" }
    });
    expect(stdout).toContain(`${FIXTURES.length}/${FIXTURES.length} fixtures passed`);
    expect(stdout).not.toContain("FAIL");
    expect(stdout).not.toContain("conformance-token");
  });

  it("fails with exit code 1 when the token is wrong", async () => {
    const url = await realEngine();
    await expect(
      run(process.execPath, [runner, "--url", url, "--token-env", "CONFORMANCE_TOKEN"], {
        env: { ...process.env, CONFORMANCE_TOKEN: "wrong" }
      })
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("HTTP 401") });
  });

  it("exits 2 with usage when --url is missing", async () => {
    await expect(run(process.execPath, [runner])).rejects.toMatchObject({ code: 2 });
  });
});

describe("conformance runner against a wrong engine", { timeout: 30_000 }, () => {
  it("fails when the engine returns a different primary action", async () => {
    const wrong = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = planForecastRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const result = JSON.parse(JSON.stringify(calculatePlanAndForecast(parsed)));
        if (result.recommendation?.primary?.action) result.recommendation.primary.action.id = "not-the-right-action";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
    });
    const results = await runAll({ url: wrong, names: ["travel-leg-protects-the-journey.json"] });
    expect(results[0]?.failures.join("\n")).toContain(
      'primary action: expected "write-chapter", got "not-the-right-action"'
    );
  });

  it("fails when requestId is not echoed or the status is not 200", async () => {
    const noEcho = await listen((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ contractVersion: "1", requestId: "00000000-0000-4000-8000-000000000000" }));
      });
    });
    const [echo] = await runAll({ url: noEcho, names: ["travel-leg-protects-the-journey.json"] });
    expect(echo?.failures.join("\n")).toContain("requestId not echoed");
    const down = await listen((_request, response) => {
      response.writeHead(500).end("{}");
    });
    const [status] = await runAll({ url: down, names: ["travel-leg-protects-the-journey.json"] });
    expect(status?.failures).toEqual(["HTTP 500, expected 200"]);
  });
});

describe("portable assertions", () => {
  it("ignores the reference-only dayPlan, directive title and minutes", () => {
    const expected = {
      currentDirective: { kind: "action", targetId: "a", title: "A", recommendedMinutes: 60 },
      dayPlan: ["x"]
    };
    expect(
      checkPortable(expected, {
        currentDirective: { kind: "action", targetId: "a", title: "Other", recommendedMinutes: 5 }
      })
    ).toEqual([]);
    expect(checkPortable(expected, { currentDirective: { kind: "sleep", targetId: "a" } })).toHaveLength(1);
  });

  it("checks candidate tiers and project health, passing and failing", () => {
    const body = {
      recommendation: { candidates: [{ action: { id: "a" }, criticalTier: "must" }] },
      schedule: { forecasts: [{ projectId: "p", health: "on_track" }] }
    };
    expect(checkPortable({ candidateTiers: { a: "must" }, health: { p: "on_track" } }, body)).toEqual([]);
    expect(checkPortable({ candidateTiers: { a: "should" } }, body)).toEqual([
      'tier of a: expected "should", got "must"'
    ]);
    expect(checkPortable({ health: { p: "behind" } }, body)).toEqual([
      'health of p: expected "behind", got "on_track"'
    ]);
    expect(checkPortable({ candidateTiers: { missing: "must" }, health: { gone: "on_track" } }, body)).toHaveLength(2);
    expect(checkPortable({ health: { p: "on_track" } }, {})).toHaveLength(1);
  });

  it("flags a malformed response shape", () => {
    expect(checkShape({})).not.toEqual([]);
    expect(checkShape(null)).toEqual(["response is not a JSON object"]);
  });
});

describe("conformance corpus", () => {
  it("lists only existing, never private, fixtures with the listed request shape", () => {
    expect(new Set(FIXTURES).size).toBe(FIXTURES.length);
    for (const name of FIXTURES) {
      expect(name, name).not.toMatch(/private/);
      expect(existsSync(join(DEFAULT_FIXTURE_DIR, name)), name).toBe(true);
      expect(planForecastRequestSchema.safeParse(readFixture(name).request).success, name).toBe(true);
    }
  });

  it("covers every synthetic fixture and the three top-level files", () => {
    const synthetic = readdirSync(join(DEFAULT_FIXTURE_DIR, "synthetic")).filter((file) => file.endsWith(".json"));
    expect(
      FIXTURES.filter((name) => name.startsWith("synthetic/"))
        .map((name) => name.slice(10))
        .sort()
    ).toEqual(synthetic.sort());
    const top = FIXTURES.filter((name) => !name.includes("/"));
    expect(top.sort()).toEqual([
      "leave-by-allows-for-variability.json",
      "tracked-overtime-keeps-return-leg.json",
      "travel-leg-protects-the-journey.json"
    ]);
  });
});
