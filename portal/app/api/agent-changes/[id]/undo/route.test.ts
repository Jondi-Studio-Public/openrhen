import type { RevertCommand } from "@openrhen/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's undo/redo door: owner only, the statuses each refusal maps to, and that an id of the write ledger is
 * reverted by the server's revert command run as the owner (the real ledger is covered by
 * `server/agent-changes.integration.test.ts`).
 */
const holder = vi.hoisted(() => ({
  store: undefined as import("@/server/agent-journal-runner").JournalStore | undefined
}));
vi.mock("@/server/agent-journal-runner", () => ({ databaseJournalStore: async () => holder.store }));

const route = await import("./route");

const WRITE = "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f";

const post = (id: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`http://localhost/api/agent-changes/${id}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  );

/** A store whose ledger holds the one agent write `WRITE`, and that records the revert commands it is asked for. */
function ledgerStore() {
  const reverts: RevertCommand[] = [];
  const store: import("@/server/agent-journal-runner").JournalStore = {
    load: async () => [],
    ledgerWrite: async (id) => (id === WRITE ? { id, agent: "companion" } : null),
    revertLedgerWrite: async (command) => {
      reverts.push(command);
    }
  };
  holder.store = store;
  return { store, reverts };
}

beforeEach(() => {
  holder.store = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/agent-changes/[id]/undo", () => {
  it("refuses any request that carries an agent identity, and reverts nothing", async () => {
    const { reverts } = ledgerStore();
    const response = await post(WRITE, {}, { "x-openrhen-agent": "companion" });
    expect(response.status).toBe(403);
    expect(reverts).toHaveLength(0);
  });

  it("undoes the write as the owner with a fresh command id, then redoes it", async () => {
    const { reverts } = ledgerStore();
    const undone = await post(WRITE, {});
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({ ok: true, direction: "undo", id: WRITE });
    const redone = await post(WRITE, { redo: true });
    expect(redone.status).toBe(200);
    expect(await redone.json()).toEqual({ ok: true, direction: "redo", id: WRITE });
    expect(reverts).toEqual([
      { commandId: expect.any(String), target: WRITE, direction: "undo" },
      { commandId: expect.any(String), target: WRITE, direction: "redo" }
    ]);
    expect(reverts[0]!.commandId).not.toBe(reverts[1]!.commandId);
  });

  it("passes force on to the revert command", async () => {
    const { reverts } = ledgerStore();
    expect((await post(WRITE, { force: true })).status).toBe(200);
    expect(reverts[0]).toMatchObject({ target: WRITE, direction: "undo", force: true });
  });

  it("answers 404 for an id that is not an agent write in the ledger, and for an id that cannot be one", async () => {
    const { reverts } = ledgerStore();
    expect((await post("e-from-the-old-journal")).status).toBe(404);
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await post("has space")).status).toBe(404);
    expect((await post("a".repeat(65))).status).toBe(404);
    expect(reverts).toHaveLength(0);
  });

  it("answers 503 when the ledger cannot be read", async () => {
    const { store, reverts } = ledgerStore();
    store.ledgerWrite = async () => {
      throw new Error("down");
    };
    expect((await post(WRITE)).status).toBe(503);
    expect(reverts).toHaveLength(0);
  });

  it("answers 400 for a body that is not { redo: boolean, force: boolean }", async () => {
    const { reverts } = ledgerStore();
    for (const body of ["not json", "[]", "null", JSON.stringify({ redo: "yes" }), JSON.stringify({ force: "yes" })])
      expect((await post(WRITE, body)).status, body).toBe(400);
    expect(reverts).toHaveLength(0);
  });

  it("answers 503 when there is no database", async () => {
    holder.store = undefined;
    expect((await post(WRITE)).status).toBe(503);
  });
});
