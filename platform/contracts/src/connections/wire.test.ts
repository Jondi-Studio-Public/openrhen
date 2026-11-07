import { describe, expect, it } from "vitest";
import { capabilityFailureSchema, connectionFailureReasonSchema, connectionsResponseSchema } from "./wire.js";

describe("connection wire", () => {
  it("unions Google's and the sign-in reasons with the host's own", () => {
    for (const reason of [
      "invalid_grant",
      "calendar_not_found",
      "session_expired",
      "login_challenge",
      "unreachable",
      "unknown_connection",
      "unsupported_operation",
      "not_ready",
      "quota_exceeded",
      "rate_limited"
    ]) {
      expect(connectionFailureReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(new Set(connectionFailureReasonSchema.options).size).toBe(connectionFailureReasonSchema.options.length);
  });

  it("parses a failure and a status response", () => {
    expect(capabilityFailureSchema.safeParse({ error: "x", reason: "not_ready" }).success).toBe(true);
    expect(capabilityFailureSchema.safeParse({ error: "x" }).success).toBe(true);
    expect(
      connectionsResponseSchema.safeParse({
        connections: [
          {
            id: "example",
            label: "Example",
            capabilities: ["calendar_source"],
            ready: false,
            missing: ["EXAMPLE_COOKIE"]
          }
        ]
      }).success
    ).toBe(true);
  });
});

describe("negative cases", () => {
  it("rejects an unknown reason and a bad status", () => {
    expect(connectionFailureReasonSchema.safeParse("exploded").success).toBe(false);
    expect(capabilityFailureSchema.safeParse({ error: "x", reason: "exploded" }).success).toBe(false);
    expect(connectionsResponseSchema.safeParse({ connections: [{ id: "example" }] }).success).toBe(false);
  });
});
