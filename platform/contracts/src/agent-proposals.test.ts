import { describe, expect, it } from "vitest";
import { AGENT_PROPOSAL_PAYLOAD_MAX_CHARS, proposeAgentChangeSchema } from "./agent-proposals.js";

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
