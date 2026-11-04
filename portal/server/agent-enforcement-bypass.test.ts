import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "./agent-tokens";

/**
 * A scoped token cannot skip enforcement by changing how it sends the body: the handler reads JSON whatever the
 * content-type says, so enforcement must too, and a body it cannot read ends at the wrapper with a 400.
 */
const principal: AgentPrincipal = {
  name: "companion",
  source: "db",
  scopes: ["write:entity", "write:recurrence", "propose:agent-change", "propose:entity"],
  directWrites: {}
};
vi.mock("@/server/agent-tokens", () => ({ identifyRequest: async () => ({ actor: "companion", principal }) }));
const propose = vi.hoisted(() => vi.fn());
vi.mock("./agent-proposals/store", () => ({ proposeAgentChange: propose }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));

const { withRoute } = await import("./logging");

const handler = vi.fn(async () => Response.json({ applied: true }));
const ID = "11111111-1111-4111-8111-111111111111";

const bodies: Record<string, unknown> = {
  "/api/commands/project": { commandId: ID, expectedVersion: null, project: { id: "p1", title: "P" } },
  "/api/commands/action": { commandId: ID, expectedVersion: null, action: { id: "a1", title: "A" } },
  "/api/commands/entity": {
    commandId: ID,
    type: "save_entity",
    entityType: "commitment",
    expectedVersion: null,
    entity: { id: "c1" }
  },
  "/api/commands/recurrence-goal": { type: "end_recurrence_goal" },
  "/api/commands/commitment-recurrence": {
    expectedVersion: null,
    rule: { id: "r1", title: "Gym", shareToCalendar: true }
  },
  "/api/agent-proposals": {
    kind: "entity_command",
    summary: "x",
    payload: { command: "save_action", body: { action: { id: "a" } } }
  }
};

const send = (route: string, body: string, headers: Record<string, string>) =>
  withRoute(route, handler)(new Request(`http://portal.test${route}`, { method: "POST", headers, body }), undefined);

beforeEach(() => {
  handler.mockClear();
  propose.mockReset();
  propose.mockResolvedValue({ proposal: { id: ID }, outcome: "created" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("body-dependent routes cannot be sent past enforcement", () => {
  for (const route of Object.keys(bodies)) {
    it(`${route}: valid JSON as text/plain or with no content-type is still decided on its content`, async () => {
      for (const headers of [{ "content-type": "text/plain" }, {}, { "content-type": "application/json" }]) {
        const response = await send(route, JSON.stringify(bodies[route]), headers);
        if (route === "/api/commands/recurrence-goal" || route === "/api/commands/commitment-recurrence") {
          // an end, or a share with the family calendar, is on the floor with no proposal form
          expect(response.status, `${route} ${JSON.stringify(headers)}`).toBe(403);
          expect(handler).not.toHaveBeenCalled();
        } else if (route === "/api/agent-proposals") {
          // allowed, but only because the scopes were checked: the handler runs
          expect(response.status).toBe(200);
        } else {
          // directWrites is off for this token, so it is filed as a proposal and the handler never runs
          expect(response.status, `${route} ${JSON.stringify(headers)}`).toBe(202);
          expect(handler).not.toHaveBeenCalled();
        }
      }
    });

    it(`${route}: a body that is not a JSON object is a 400 and never reaches the handler`, async () => {
      for (const body of ["{", "", "[1]", "null", '"text"'])
        for (const headers of [{ "content-type": "text/plain" }, {}, { "content-type": "application/json" }]) {
          const response = await send(route, body, headers);
          expect(response.status, `${route} ${body} ${JSON.stringify(headers)}`).toBe(400);
        }
      expect(handler).not.toHaveBeenCalled();
      expect(propose).not.toHaveBeenCalled();
    });
  }

  it("requires the per-entity propose scope for a proposal sent as text/plain", async () => {
    principal.scopes = ["propose:agent-change"];
    const response = await send("/api/agent-proposals", JSON.stringify(bodies["/api/agent-proposals"]), {
      "content-type": "text/plain"
    });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    principal.scopes = ["write:entity", "write:recurrence", "propose:agent-change", "propose:entity"];
  });
});

describe("owner-only routes refuse a database token through the real wrapper", () => {
  const request = (method: string, route: string, body?: string) =>
    withRoute(route, handler)(
      new Request(`http://portal.test${route}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body })
      }),
      undefined
    );
  const everyScope = ["read:plan", "read:changes", "read:proposals", "write:entity", "write:undo"];

  it("answers 403 to PATCH /api/agent-tokens/[id] (OWNER_ROUTES), so a token cannot widen itself", async () => {
    principal.scopes = everyScope;
    const response = await request(
      "PATCH",
      "/api/agent-tokens/[id]",
      JSON.stringify({ directWrites: { action: "on" } })
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain("for the owner");
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 403 to GET /api/agent-changes (OWNER_READS), whatever scopes the token holds", async () => {
    principal.scopes = everyScope;
    const response = await request("GET", "/api/agent-changes");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain("for the owner");
    expect(handler).not.toHaveBeenCalled();
  });

  it("is not a block on every route: a read the token's scopes cover still reaches the handler", async () => {
    principal.scopes = ["read:changes"];
    const response = await request("GET", "/api/changes");
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
