import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findUnconvertibleRules, UNCONVERTED_RULES } from "./plan-forecast-json-schema.js";
import { planForecastRequestSchema, planForecastResponseSchema } from "./plan-forecast.js";

const REGENERATE =
  "UPDATE_ENGINE_WIRE_SCHEMA=1 corepack pnpm --filter @openrhen/engine-service exec vitest run engine-wire-schema (on Windows set the variable first)";

describe("rules that JSON Schema cannot express", () => {
  it("lists every refinement or transform found in the request schema, and nothing else", () => {
    const found = findUnconvertibleRules(planForecastRequestSchema)
      .map((rule) => rule.path)
      .sort();
    const listed = UNCONVERTED_RULES.map((rule) => rule.path).sort();
    expect(
      found,
      `A refinement or transform in planForecastRequestSchema has no entry in UNCONVERTED_RULES ` +
        `(platform/contracts/src/planning/plan-forecast-json-schema.ts), or an entry names one that is gone. ` +
        `Add or remove the entry, then regenerate with ${REGENERATE}`
    ).toEqual(listed);
  });

  it("lists every refinement in the response schema too (none today)", () => {
    expect(findUnconvertibleRules(planForecastResponseSchema)).toEqual([]);
  });

  it("gives each entry a rule and a source", () => {
    for (const rule of UNCONVERTED_RULES) {
      expect(rule.rule.length, rule.path).toBeGreaterThan(10);
      expect(rule.source, rule.path).toMatch(/\.ts$/);
    }
  });

  it("notices a new refinement (guard against the walker going blind)", () => {
    const extended = z.object({ a: z.object({ b: z.number() }).refine((v) => v.b > 0) });
    expect(findUnconvertibleRules(extended).map((rule) => rule.path)).toEqual(["a"]);
  });
});
