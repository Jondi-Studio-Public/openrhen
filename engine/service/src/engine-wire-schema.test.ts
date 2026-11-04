import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENGINE_WIRE_ERROR_CODES_FILE,
  ENGINE_WIRE_UNCONVERTED_RULES,
  ENGINE_WIRE_UNCONVERTED_RULES_FILE,
  engineWireFiles,
  PLAN_FORECAST_REQUEST_SCHEMA_FILE,
  PLAN_FORECAST_RESPONSE_SCHEMA_FILE,
  type EngineWireErrorCode
} from "@openrhen/contracts";

/**
 * The files are generated from the zod schemas and committed under `platform/contracts/engine-wire/`.
 * Regenerate (bash):       UPDATE_ENGINE_WIRE_SCHEMA=1 corepack pnpm --filter @openrhen/engine-service exec vitest run engine-wire-schema
 * Regenerate (Windows shell): set the variable first, run the same command, then remove it.
 */
const REGENERATE =
  "UPDATE_ENGINE_WIRE_SCHEMA=1 corepack pnpm --filter @openrhen/engine-service exec vitest run engine-wire-schema (on Windows set the variable first)";

const dir = fileURLToPath(new URL("../../../platform/contracts/engine-wire/", import.meta.url));
const serverFile = fileURLToPath(new URL("./server.ts", import.meta.url));

if (process.env.UPDATE_ENGINE_WIRE_SCHEMA === "1") {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(engineWireFiles())) writeFileSync(dir + name, content);
}

describe("the committed engine wire files", () => {
  for (const [name, content] of Object.entries(engineWireFiles())) {
    it(`${name} matches what the zod schemas generate`, () => {
      expect(readFileSync(dir + name, "utf8"), `${name} is stale: regenerate with ${REGENERATE}`).toBe(content);
    });
  }
});

describe("the request schema", () => {
  const schema = JSON.parse(readFileSync(dir + PLAN_FORECAST_REQUEST_SCHEMA_FILE, "utf8"));

  it("states that it is structural only", () => {
    expect(schema.description).toMatch(/necessary, not sufficient/);
    expect(schema.description).toMatch(/server is the authority/);
    expect(schema["x-unconverted-rules"]).toEqual(ENGINE_WIRE_UNCONVERTED_RULES);
  });

  it("is generated for the input side, so defaulted fields are optional", () => {
    expect(schema.required).toEqual(expect.arrayContaining(["contractVersion", "requestId", "state"]));
    expect(schema.required).not.toContain("deliverables");
    expect(schema.required).not.toContain("journeys");
  });

  it("is generated for the output side on the response, so defaulted fields are always present", () => {
    const response = JSON.parse(readFileSync(dir + PLAN_FORECAST_RESPONSE_SCHEMA_FILE, "utf8"));
    expect(response.$schema).toMatch(/2020-12/);
    expect(response.description).toMatch(/necessary, not sufficient/);
  });

  it("does not leave the recursive JSON value as an unresolved reference", () => {
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"\$ref":"#\/\$defs\/__schema/);
  });
});

describe("the error code list", () => {
  const listed = JSON.parse(readFileSync(dir + ENGINE_WIRE_ERROR_CODES_FILE, "utf8")) as {
    errors: EngineWireErrorCode[];
  };

  it("lists the six codes the plan names", () => {
    expect(listed.errors.map((entry) => `${entry.status} ${entry.code}`).sort()).toEqual(
      [
        "400 invalid_json",
        "400 validation_failed",
        "401 unauthorised",
        "404 not_found",
        "413 payload_too_large",
        "500 calculation_failed"
      ].sort()
    );
  });

  it("matches every error code engine/service/src/server.ts can send", () => {
    const source = readFileSync(serverFile, "utf8");
    const sent = [...source.matchAll(/json\(\s*response,\s*(\d{3}),\s*\{\s*error:\s*\{\s*code:\s*"([a-z_]+)"/g)].map(
      (match) => `${match[1]} ${match[2]}`
    );
    const anyCode = [...source.matchAll(/code:\s*"([a-z_]+)"/g)].map((match) => match[1]);
    expect(sent.length, "the server.ts pattern changed; update this test's pattern").toBe(anyCode.length);
    expect(
      sent.sort(),
      `engine/service/src/server.ts sends an error code that ${ENGINE_WIRE_ERROR_CODES_FILE} does not list (or the reverse). ` +
        `Edit platform/contracts/engine-wire/${ENGINE_WIRE_ERROR_CODES_FILE} (source: ERROR_CODES in platform/contracts/src/planning/plan-forecast-json-schema.ts)`
    ).toEqual(listed.errors.map((entry) => `${entry.status} ${entry.code}`).sort());
  });

  it("has the unconverted-rules file beside it", () => {
    const rules = JSON.parse(readFileSync(dir + ENGINE_WIRE_UNCONVERTED_RULES_FILE, "utf8"));
    expect(rules.rules).toEqual(ENGINE_WIRE_UNCONVERTED_RULES);
  });
});
