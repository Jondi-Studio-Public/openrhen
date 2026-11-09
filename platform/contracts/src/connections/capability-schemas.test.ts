import { describe, expect, it } from "vitest";
import { CAPABILITY_OPS } from "./capabilities.js";
import {
  CAPABILITY_OP_SCHEMAS,
  connectionProofResultSchema,
  isPendingOp,
  opsMissingSchemas,
  pendingOps
} from "./capability-schemas.js";

describe("capability op schemas", () => {
  it("gives every cap.op a request and a response schema, or lists it as pending", () => {
    expect(opsMissingSchemas(CAPABILITY_OPS, CAPABILITY_OP_SCHEMAS)).toEqual([]);
  });

  it("fails a fixture op that has no schemas", () => {
    const ops = { ...CAPABILITY_OPS, fixture_capability: ["fixture_op"] };
    expect(opsMissingSchemas(ops, CAPABILITY_OP_SCHEMAS)).toEqual(["fixture_capability.fixture_op"]);
  });

  it("fails an op of a known capability that is missing from the table", () => {
    const ops = { ...CAPABILITY_OPS, travel_time: [...CAPABILITY_OPS.travel_time, "fixture_op"] };
    expect(opsMissingSchemas(ops, CAPABILITY_OP_SCHEMAS)).toEqual(["travel_time.fixture_op"]);
  });

  it("fails an op with only one of the two schemas", () => {
    const table = { fixture_capability: { fixture_op: { request: CAPABILITY_OP_SCHEMAS.travel_time.matrix } } };
    expect(opsMissingSchemas({ fixture_capability: ["fixture_op"] }, table)).toEqual(["fixture_capability.fixture_op"]);
  });

  it("holds a table entry for no op that CAPABILITY_OPS does not list", () => {
    for (const [capability, table] of Object.entries(CAPABILITY_OP_SCHEMAS)) {
      const listed: readonly string[] = CAPABILITY_OPS[capability as keyof typeof CAPABILITY_OPS];
      expect(Object.keys(table).sort()).toEqual([...listed].sort());
    }
  });

  it("leaves only the model_provider ops pending, and that list only shrinks", () => {
    expect(pendingOps(CAPABILITY_OP_SCHEMAS)).toEqual([
      "model_provider.extract",
      "model_provider.stream",
      "model_provider.embed",
      "model_provider.complete",
      "model_provider.probe"
    ]);
    expect(isPendingOp(CAPABILITY_OP_SCHEMAS.model_provider.probe)).toBe(true);
    expect(isPendingOp(CAPABILITY_OP_SCHEMAS.travel_time.matrix)).toBe(false);
  });

  it("parses a request and a response for the ops that have schemas", () => {
    const instant = "2026-01-01T09:00:00.000Z";
    const { calendar_source, calendar_sink, geocoding, status_publish, video_metadata } = CAPABILITY_OP_SCHEMAS;
    const ok = (entry: unknown, kind: "request" | "response", value: unknown) =>
      (entry as Record<typeof kind, { safeParse(v: unknown): { success: boolean } }>)[kind].safeParse(value).success;

    expect(ok(calendar_source.proof, "request", {})).toBe(true);
    expect(ok(calendar_source.list_calendars, "response", { calendars: [] })).toBe(true);
    expect(
      ok(calendar_source.read_events, "request", { timeMin: instant, timeMax: instant, dateStart: "a", dateEnd: "b" })
    ).toBe(true);
    expect(ok(calendar_source.read_events, "request", { timeMin: "not a time" })).toBe(false);
    expect(ok(calendar_sink.remove, "request", { eventId: "7" })).toBe(true);
    expect(ok(calendar_sink.remove, "request", {})).toBe(false);
    expect(ok(calendar_sink.status, "response", { writeEnabled: true, frameId: null })).toBe(true);
    expect(ok(geocoding.geocode, "request", { query: "somewhere" })).toBe(true);
    expect(ok(geocoding.geocode, "request", { query: "" })).toBe(false);
    expect(ok(status_publish.config, "response", { configured: false, host: null })).toBe(true);
    expect(ok(status_publish.publish, "response", { outcome: "delivered", httpStatus: 200 })).toBe(true);
    expect(ok(video_metadata.durations, "request", { apiKey: "k", ids: ["abcdefghijk"] })).toBe(true);
    expect(ok(video_metadata.durations, "request", { apiKey: "k", ids: [] })).toBe(false);
  });

  it("reads a proof result for each status and lets a connected one add fields", () => {
    expect(connectionProofResultSchema.safeParse({ status: "not_configured", missing: ["X"] }).success).toBe(true);
    const connected = connectionProofResultSchema.parse({
      status: "connected",
      checkedAt: "2026-01-01T09:00:00.000Z",
      host: "example.test"
    });
    expect(connected).toMatchObject({ host: "example.test" });
    expect(
      connectionProofResultSchema.safeParse({
        status: "failed",
        checkedAt: "2026-01-01T09:00:00.000Z",
        message: "no",
        reason: "unreachable"
      }).success
    ).toBe(true);
    expect(connectionProofResultSchema.safeParse({ status: "connected" }).success).toBe(false);
  });
});
