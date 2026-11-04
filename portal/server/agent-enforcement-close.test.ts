import { describe, expect, it, vi } from "vitest";
import { closeEntityPayloadSchema } from "@openrhen/contracts";
import { enforceAgentRequest, type EnforceDeps } from "./agent-enforcement";
import type { AgentPrincipal } from "./agent-tokens";

const ID = "22222222-2222-4222-8222-222222222222";
const ROUTE = "/api/commands/close";

const principal = (scopes: string[], directWrites: AgentPrincipal["directWrites"] = {}): AgentPrincipal => ({
  name: "scribe",
  source: "db",
  tokenId: "t1",
  scopes,
  directWrites
});

const fakePropose = () =>
  vi.fn<NonNullable<EnforceDeps["propose"]>>(async (_agent, input) => ({
    proposal: { id: ID, kind: input.kind, summary: input.summary } as never
  }));

const send = (
  held: AgentPrincipal,
  body: Record<string, unknown>,
  facts: Awaited<ReturnType<NonNullable<EnforceDeps["stored"]>>>,
  propose = fakePropose()
) =>
  enforceAgentRequest(
    new Request(`http://portal.test${ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    ROUTE,
    held,
    { basis: "stated", evidence: "asked" },
    { stored: async () => facts, propose }
  ).then((response) => ({ response, propose }));

const close = { type: "action", id: "a1", verb: "cancel", do: "close", reason: "no longer needed" };
const mayCloseActions = principal(["write:entity:action"], { action: "on" });

describe("archive and cancel enforcement", () => {
  it("applies a plain close the token may write directly", async () => {
    const { response, propose } = await send(mayCloseActions, close, { closeTypes: ["action"], rowCount: 1 });
    expect(response).toBeNull();
    expect(propose).not.toHaveBeenCalled();
  });

  it("files a proposal when the stored rows could not be read", async () => {
    const { response, propose } = await send(mayCloseActions, close, {});
    expect(response?.status).toBe(202);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("files ONE close_entity proposal that pins the target and the rows under it", async () => {
    const { response, propose } = await send(
      principal(["write:entity:project"], { project: "on" }),
      { ...close, type: "project", id: "p1", verb: "archive", includeChildren: true },
      {
        closeTypes: ["project", "action"],
        needsOwner: true,
        rowCount: 2,
        closeVersion: 4,
        closeChildren: [{ type: "action", id: "a1", version: 2 }]
      }
    );
    expect(response?.status).toBe(202);
    expect(propose).toHaveBeenCalledTimes(1);
    const filed = propose.mock.calls[0]![1];
    expect(filed).toMatchObject({ kind: "close_entity", coalesceKey: "close:project:p1" });
    expect(closeEntityPayloadSchema.parse(filed.payload)).toMatchObject({
      type: "project",
      expectedVersion: 4,
      includeChildren: true,
      children: [{ type: "action", id: "a1", version: 2 }]
    });
  });

  it("files a shared commitment's close for the owner", async () => {
    const { response } = await send(
      principal(["write:entity:commitment"], { commitment: "on" }),
      { ...close, type: "commitment", id: "c1" },
      { closeTypes: ["commitment"], shared: true }
    );
    expect(response?.status).toBe(202);
  });

  it("holds a call past 20 rows even when everything else allows it", async () => {
    expect((await send(mayCloseActions, close, { closeTypes: ["action"], rowCount: 20 })).response).toBeNull();
    const over = await send(mayCloseActions, close, { closeTypes: ["action"], rowCount: 21 });
    expect(over.response?.status).toBe(202);
  });

  it("needs a direct write for every type the call reaches, else it is one proposal", async () => {
    const project = { ...close, type: "project", id: "p1", verb: "archive", includeChildren: true };
    const facts = { closeTypes: ["project", "action"], rowCount: 2 };
    const noChildScope = await send(principal(["write:entity:project"], { project: "on" }), project, facts);
    expect(noChildScope.response?.status).toBe(202);
    expect(noChildScope.propose).toHaveBeenCalledTimes(1);
    const shadowChild = await send(
      principal(["write:entity:project", "write:entity:action"], { project: "on", action: "shadow" }),
      project,
      facts
    );
    expect(shadowChild.propose.mock.calls[0]![1]).toMatchObject({ shadow: true });
    const allOn = await send(
      principal(["write:entity:project", "write:entity:action"], { project: "on", action: "on" }),
      project,
      facts
    );
    expect(allOn.response).toBeNull();
  });

  it("files a close when direct writes are not on for the target", async () => {
    const { response } = await send(principal(["write:entity:action"], { action: "off" }), close, {
      closeTypes: ["action"]
    });
    expect(response?.status).toBe(202);
  });

  it("denies a token with no scope for the target", async () => {
    const { response, propose } = await send(principal(["write:entity:area"], { area: "on" }), close, {
      closeTypes: ["action"]
    });
    expect(response?.status).toBe(403);
    expect(propose).not.toHaveBeenCalled();
  });

  it("restores directly only a row this agent closed itself", async () => {
    const restore = { ...close, do: "restore", expectedVersion: 3 };
    const facts = { closeTypes: ["action"], rowCount: 1, closeVersion: 3 };
    expect((await send(mayCloseActions, restore, { ...facts, restorableByAgent: true })).response).toBeNull();
    for (const extra of [{ restorableByAgent: false }, {}]) {
      const held = await send(mayCloseActions, restore, { ...facts, ...extra });
      expect(held.response?.status).toBe(202);
      expect(held.propose.mock.calls[0]![1].payload).toMatchObject({ do: "restore", expectedVersion: 3 });
    }
  });
});
