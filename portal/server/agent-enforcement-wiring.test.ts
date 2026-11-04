import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "./agent-tokens";

/** `withRoute` hands a database token's request to enforcement before the handler, and not an environment token's. */
const identity = vi.hoisted(() => ({ current: undefined as undefined | { actor: string; principal: AgentPrincipal } }));
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async () => identity.current ?? { actor: undefined }
}));
const enforce = vi.hoisted(() => vi.fn());
vi.mock("@/server/agent-enforcement", () => ({ enforceAgentRequest: enforce }));

const { withRoute } = await import("./logging");

const handler = vi.fn(async () => Response.json({ ok: true }));
const route = withRoute("/api/commands/session", handler);
const post = () =>
  route(new Request("http://portal.test/api/commands/session", { method: "POST", body: "{}" }), undefined);

beforeEach(() => {
  handler.mockClear();
  enforce.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("withRoute and agent enforcement", () => {
  it("stops a database token's request with the enforcement response and never runs the handler", async () => {
    identity.current = {
      actor: "companion",
      principal: { name: "companion", source: "db", scopes: [], directWrites: {} }
    };
    enforce.mockResolvedValue(Response.json({ proposal: { id: "p" } }, { status: 202 }));
    expect((await post()).status).toBe(202);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler when enforcement lets a database token through", async () => {
    identity.current = {
      actor: "companion",
      principal: { name: "companion", source: "db", scopes: [], directWrites: {} }
    };
    enforce.mockResolvedValue(null);
    expect((await post()).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not enforce for an environment token or an anonymous caller", async () => {
    identity.current = { actor: "scribe", principal: { name: "scribe", source: "env", directWrites: {} } };
    expect((await post()).status).toBe(200);
    identity.current = undefined;
    expect((await post()).status).toBe(200);
    expect(enforce).not.toHaveBeenCalled();
  });
});
