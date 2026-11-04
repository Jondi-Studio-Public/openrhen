import { z } from "zod";
import { withoutDatePatterns } from "../agent-sessions.js";
import { jsonValueSchema, planForecastRequestSchema, planForecastResponseSchema } from "./plan-forecast.js";

/**
 * Structural JSON Schema for the engine wire (`POST /v1/plan-and-forecast`), generated from the zod
 * schemas and committed under `platform/contracts/engine-wire/`. The committed files are checked by
 * `engine/service/src/engine-wire-schema.test.ts` (it needs node types the contracts package lacks), which also holds the regenerate command.
 *
 * `io` is chosen on purpose, once per direction:
 * - The request uses `io: "input"`. A client sends what the schema accepts, and a `.default()` field
 *   (`deliverables`, `journeys`, many state arrays) may be omitted, so it is optional in the schema.
 * - The response uses `io: "output"`. A client reads what the engine emits, and a `.default()` field is
 *   always present there, so it is required in the schema.
 *
 * `unrepresentable: "any"` turns a construct JSON Schema cannot hold into an unconstrained value
 * rather than throwing; every such construct is a refinement, and each one is listed below.
 */

export const PLAN_FORECAST_REQUEST_SCHEMA_FILE = "plan-forecast-request.v1.schema.json";
export const PLAN_FORECAST_RESPONSE_SCHEMA_FILE = "plan-forecast-response.v1.schema.json";
export const ENGINE_WIRE_UNCONVERTED_RULES_FILE = "unconverted-rules.json";
export const ENGINE_WIRE_ERROR_CODES_FILE = "error-codes.json";

const HEADER =
  "Structural schema for the engine wire, generated from the zod schemas. A valid schema is necessary, not sufficient: " +
  "the server is the authority. It checks shape only; the rules in x-unconverted-rules (and the format keywords, " +
  "which many validators treat as annotations) are enforced only by the server, so a document can pass this " +
  "schema and still be refused with validation_failed.";

export interface UnconvertedRule {
  /** Where the rule sits in the request, as `findUnconvertibleRules` reports it (`[]` is an array element, `|n` a union branch). */
  path: string;
  rule: string;
  /** The file that owns the rule. */
  source: string;
}

/**
 * Every refinement or transform in the request schema, which JSON Schema cannot express. The test
 * fails when `findUnconvertibleRules(planForecastRequestSchema)` finds a path that is not here, or
 * one here that no longer exists. `requestId` being a UUID is not in this list: it converts (to
 * `format: "uuid"`), though validators may treat `format` as an annotation.
 */
export const UNCONVERTED_RULES: readonly UnconvertedRule[] = [
  {
    path: "",
    rule: "horizonEnd must be after calculatedAt and at most 366 days (PLAN_FORECAST_MAX_HORIZON_DAYS) after it.",
    source: "platform/contracts/src/planning/plan-forecast.ts"
  },
  {
    path: "deliverables[].executionOptions[]",
    rule: "Estimates must be ordered optimisticMinutes <= expectedMinutes <= pessimisticMinutes, and minimumSessionMinutes must not exceed maximumSessionMinutes.",
    source: "platform/contracts/src/planning/deliverable-projection.ts"
  },
  {
    path: "state",
    rule: "Ids unique per entity kind; recovery window needs both ends and they must differ; outcomes, projects and actions must reference existing parents and dependencies; per-action session range, estimate ordering and recurrence/cadence consistency (cross-reference and cross-field checks).",
    source: "platform/contracts/src/portal/state-schema.ts"
  },
  {
    path: "state.actions[].recurrence",
    rule: "An end_date recurrence needs an end date, a total_minutes recurrence needs a target, and minimum spacing times target occurrences must fit within a days period.",
    source: "platform/contracts/src/portal/state-schema.ts"
  },
  {
    path: "state.commitmentRecurrenceRules[].repeat|1.weekdays",
    rule: "Weekdays must be listed once each, in ascending order.",
    source: "platform/contracts/src/planning/commitment-repeat.ts"
  },
  {
    path: "state.conditionDefinitions[]",
    rule: "A live condition names exactly one of recurrenceRuleId or commitmentId; every other kind names neither.",
    source: "platform/contracts/src/planning/context-model.ts"
  },
  {
    path: "state.settings.timeBands[]",
    rule: "A time band's start must be before its end.",
    source: "platform/contracts/src/portal/state-schema.ts"
  },
  {
    path: "state.spans[]",
    rule: "A span's endDate must not be before its startDate.",
    source: "platform/contracts/src/planning/span.ts"
  },
  {
    path: "state.spans[].window",
    rule: "A span window must end after it starts (it cannot cross midnight).",
    source: "platform/contracts/src/planning/span.ts"
  }
];

export interface ErrorCodeEntry {
  status: number;
  code: string;
  meaning: string;
}

/** The error bodies `engine/service/src/server.ts` sends, as `{ error: { code, message } }`. The test reads `server.ts` and fails on a code missing here. */
export const ERROR_CODES: readonly ErrorCodeEntry[] = [
  { status: 400, code: "invalid_json", meaning: "The request body was not valid JSON." },
  {
    status: 400,
    code: "validation_failed",
    meaning: "The body parsed but failed planForecastRequestSchema; the error carries zod `issues`."
  },
  { status: 401, code: "unauthorised", meaning: "The bearer token was missing or wrong." },
  {
    status: 404,
    code: "not_found",
    meaning: "No such route (only POST /v1/plan-and-forecast, GET /health and GET /ready exist)."
  },
  { status: 413, code: "payload_too_large", meaning: "The body exceeded the configured payload limit." },
  {
    status: 500,
    code: "calculation_failed",
    meaning: "The engine threw, or its result failed planForecastResponseSchema."
  }
];

type Walkable = { _zod?: { def?: Record<string, unknown> } };

/** The refinements (custom checks) and transforms inside a zod schema, with the path each sits at. Lazy schemas are followed once per branch. */
export function findUnconvertibleRules(root: unknown): { path: string; kind: "refine" | "transform" }[] {
  const found: { path: string; kind: "refine" | "transform" }[] = [];
  const visit = (node: Walkable | undefined, path: string, ancestors: readonly unknown[]) => {
    const def = node?._zod?.def;
    if (!node || !def || ancestors.includes(node)) return;
    const trail = [...ancestors, node];
    const checks = (def.checks as { _zod?: { def?: { check?: string } } }[] | undefined) ?? [];
    if (checks.some((check) => check._zod?.def?.check === "custom")) found.push({ path, kind: "refine" });
    if (def.type === "transform" || (def.type === "pipe" && (def.out as Walkable)?._zod?.def?.type === "transform"))
      found.push({ path, kind: "transform" });
    const shape = def.shape as Record<string, Walkable> | undefined;
    if (shape) for (const [key, child] of Object.entries(shape)) visit(child, path ? `${path}.${key}` : key, trail);
    if (def.element) visit(def.element as Walkable, `${path}[]`, trail);
    for (const key of ["innerType", "in", "out", "left", "right", "keyType", "valueType"])
      if (def[key]) visit(def[key] as Walkable, path, trail);
    const options = def.options as Walkable[] | undefined;
    if (options) options.forEach((option, index) => visit(option, `${path}|${index}`, trail));
    const items = def.items as Walkable[] | undefined;
    if (items) items.forEach((item, index) => visit(item, `${path}.${index}`, trail));
    if (typeof def.getter === "function") visit((def.getter as () => Walkable)(), path, trail);
  };
  visit(root as Walkable, "", []);
  return found;
}

/** Stringify with a stable shape and a trailing newline, so the committed files diff cleanly. */
const render = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function generate(
  schema: z.ZodType,
  io: "input" | "output",
  id: string,
  title: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  const body = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    // jsonValueSchema is recursive; its JSON Schema is simply "any JSON value", which is the empty schema.
    override: (context) => {
      if (context.zodSchema === (jsonValueSchema as unknown)) {
        for (const key of Object.keys(context.jsonSchema)) delete context.jsonSchema[key];
        context.jsonSchema.description = "Any JSON value.";
      }
    }
  }) as Record<string, unknown>;
  const { $schema, ...rest } = withoutDatePatterns(body) as Record<string, unknown>;
  return { $schema, $id: id, title, description: HEADER, ...extra, ...rest };
}

export function planForecastRequestJsonSchema(): Record<string, unknown> {
  return generate(
    planForecastRequestSchema as z.ZodType,
    "input",
    "https://openrhen.example/schemas/plan-forecast-request.v1.json",
    "OpenRhen engine plan-and-forecast request, contract version 1",
    { "x-unconverted-rules": UNCONVERTED_RULES }
  );
}

export function planForecastResponseJsonSchema(): Record<string, unknown> {
  return generate(
    planForecastResponseSchema as z.ZodType,
    "output",
    "https://openrhen.example/schemas/plan-forecast-response.v1.json",
    "OpenRhen engine plan-and-forecast response, contract version 1",
    { "x-unconverted-rules": [] }
  );
}

/** Every generated file under `platform/contracts/engine-wire/`, by file name. */
export function engineWireFiles(): Record<string, string> {
  return {
    [PLAN_FORECAST_REQUEST_SCHEMA_FILE]: render(planForecastRequestJsonSchema()),
    [PLAN_FORECAST_RESPONSE_SCHEMA_FILE]: render(planForecastResponseJsonSchema()),
    [ENGINE_WIRE_UNCONVERTED_RULES_FILE]: render({
      note: "Rules the server enforces that the structural schema cannot express. Generated from UNCONVERTED_RULES; do not edit.",
      rules: UNCONVERTED_RULES
    }),
    [ENGINE_WIRE_ERROR_CODES_FILE]: render({
      note: "Every error code engine/service/src/server.ts sends, as { error: { code, message } }. Generated from ERROR_CODES; do not edit.",
      errors: ERROR_CODES
    })
  };
}
