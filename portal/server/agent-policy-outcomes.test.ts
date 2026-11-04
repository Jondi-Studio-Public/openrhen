import { describe, expect, it } from "vitest";
import {
  AGENT_SCOPE_PRESETS,
  agentPolicyLines,
  allDirectWritesOn,
  classifiedRoutes,
  scopesForRoute
} from "@openrhen/contracts";
import { decideWrite } from "./agent-enforcement";
import type { AgentPrincipal } from "./agent-tokens";

/**
 * The policy text (`agent-policy-text.ts`) tells agents which guarded writes are filed as proposals and which are
 * refused. This pins each write it names to what the route and `decideWrite` actually do, for a token that holds
 * every scope and has direct writes on, so the sentence and the code cannot drift apart.
 */
const everything: AgentPrincipal = {
  name: "companion",
  source: "db",
  tokenId: "t1",
  scopes: [
    "write:entity",
    "write:recurrence",
    "write:import",
    "write:inbox",
    "write:email-review",
    "act:email-draft",
    "act:inbox"
  ],
  directWrites: allDirectWritesOn()
};

const ID = "11111111-1111-4111-8111-111111111111";
const save = (entityType: string, entity: Record<string, unknown>) => ({
  commandId: ID,
  type: "save_entity",
  entityType,
  expectedVersion: 3,
  entity
});

function outcome(method: string, route: string, body?: unknown): string {
  const decision = scopesForRoute(method, route, body);
  if (decision.kind !== "scopes") return decision.kind;
  // Grant whatever the route asks, so only the hard floor can stop it.
  const held = { ...everything, scopes: [...(everything.scopes ?? []), ...decision.scopes] };
  return decideWrite(decision, held).action;
}

describe("the policy's guarded writes", () => {
  it.each([
    ["removing a span", "POST", "/api/commands/entity", save("span", { id: "s1", remove: true })],
    ["removing a sleep log entry", "POST", "/api/commands/entity", save("sleep_log_entry", { id: "n1", remove: true })],
    [
      "a save that shares with the family calendar",
      "POST",
      "/api/commands/entity",
      save("commitment", { title: "Dentist", shareToCalendar: true })
    ]
  ])("files %s as a proposal", (_name, method, route, body) => {
    expect(outcome(method, route, body)).toBe("propose");
  });

  it.each([
    ["ending a recurrence", "POST", "/api/commands/recurrence-goal", { type: "end_goal" }],
    ["deleting an import batch", "DELETE", "/api/imports/[id]", undefined]
    // Dropping a kept item is refused by the capture handler, which sees the row's status (
    // kept-drop-floor.integration.test.ts); the route alone cannot tell a kept item from a pending one.
  ])("refuses %s", (_name, method, route, body) => {
    expect(outcome(method, route, body)).toBe("deny");
  });

  it("says so in the policy text", () => {
    const text = agentPolicyLines()
      .map((line) => line.full)
      .join("\n");
    expect(text).toMatch(/Filed as proposals[^.]*removing a span or sleep log entry/);
    expect(text).toMatch(
      /Refused[^.]*ending a recurrence \(set its end date instead\), deleting an import batch and dropping a kept item/
    );
  });
});

describe("re-entry for a propose-only token", () => {
  for (const preset of ["scribe", "assistant"]) {
    const principal: AgentPrincipal = {
      name: preset,
      source: "db",
      tokenId: "t2",
      scopes: [...AGENT_SCOPE_PRESETS[preset]!],
      directWrites: {}
    };

    it(`${preset}: the answers route is refused for lack of write:catch-up`, () => {
      const decision = scopesForRoute("POST", "/api/commands/reenter", {});
      if (decision.kind !== "scopes") throw new Error("expected scopes");
      expect(decideWrite(decision, principal)).toEqual({ action: "deny", missing: ["write:catch-up"] });
    });

    it(`${preset}: the read is open to it, and no other route has an any-of rule`, () => {
      const anyOfRoutes = classifiedRoutes().filter((key) => {
        const [method, route] = key.split(" ") as [string, string];
        const decision = scopesForRoute(method, route, {});
        return decision.kind === "scopes" && decision.anyOf !== undefined;
      });
      expect(anyOfRoutes).toEqual(["GET /api/commands/reenter"]);
      const read = scopesForRoute("GET", "/api/commands/reenter");
      expect(read.kind === "scopes" && read.anyOf?.some((scope) => principal.scopes?.includes(scope))).toBe(true);
    });
  }
});
