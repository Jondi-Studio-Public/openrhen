import { describe, expect, it } from "vitest";
import {
  AGENT_PROPOSAL_PAYLOAD_MAX_CHARS,
  SERVER_FILED_KINDS,
  closeEntityPayloadSchema,
  proposeAgentChangeSchema
} from "./agent-proposals.js";

describe("proposeAgentChangeSchema payload cap", () => {
  const base = { kind: "entity_command", summary: "Rename" };

  it("accepts a payload under the cap", () => {
    expect(proposeAgentChangeSchema.safeParse({ ...base, payload: { note: "x".repeat(1000) } }).success).toBe(true);
  });

  it("refuses a payload over the cap", () => {
    const payload = { note: "x".repeat(AGENT_PROPOSAL_PAYLOAD_MAX_CHARS) };
    const result = proposeAgentChangeSchema.safeParse({ ...base, payload });
    expect(result.success).toBe(false);
  });
});

describe("close_entity proposals", () => {
  it("names the kinds only the server files", () => {
    expect([...SERVER_FILED_KINDS].sort()).toEqual(["close_entity", "entity_command_batch", "settle_catch_up"]);
  });

  it("holds the target, the verb and the children the proposal pinned", () => {
    const parsed = closeEntityPayloadSchema.parse({
      type: "project",
      verb: "archive",
      id: "p1",
      do: "close",
      expectedVersion: 3,
      reason: "tidy",
      includeChildren: true,
      children: [{ type: "action", id: "a1", version: 2 }]
    });
    expect(parsed.children).toHaveLength(1);
    expect(closeEntityPayloadSchema.safeParse({ type: "span", verb: "archive", id: "p1", do: "close" }).success).toBe(
      false
    );
    expect(
      closeEntityPayloadSchema.safeParse({ type: "project", verb: "archive", id: "p1", do: "restore" }).success
    ).toBe(false);
    expect(
      closeEntityPayloadSchema.safeParse({
        type: "project",
        verb: "archive",
        id: "p1",
        do: "close",
        children: Array.from({ length: 501 }, (_, i) => ({ type: "action", id: `a${i}`, version: 1 }))
      }).success
    ).toBe(false);
  });
});
