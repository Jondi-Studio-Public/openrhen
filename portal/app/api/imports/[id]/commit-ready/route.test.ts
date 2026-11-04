import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenCommandError } from "@/server/persistence/postgres/command-errors";

/**
 * Store and state store are replaced wholesale. Under test is the envelope: both batches and the
 * refreshed state on success, a 409 for a stale version, a 403 for an agent's commit on the hard floor, a 400 for a batch with nothing ready.
 */
class FakeConflictError extends Error {}
const store = { commitReady: vi.fn() };
const state = { get: vi.fn() };

vi.mock("@/server/persistence/postgres/import-store", () => ({
  ImportConflictError: FakeConflictError,
  withImportStore: (operation: (value: typeof store) => unknown) => operation(store)
}));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => state }));

const { POST } = await import("./route");

const id = "22222222-2222-4222-8222-222222222222";
const post = (body: unknown) =>
  POST(
    new Request(`http://portal.test/api/imports/${id}/commit-ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  store.commitReady.mockReset();
  state.get.mockReset();
  state.get.mockResolvedValue({ areas: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/imports/[id]/commit-ready", () => {
  it("answers with the committed batch, the deferred batch and the new state", async () => {
    store.commitReady.mockResolvedValue({
      batch: { id, status: "committed" },
      deferred: { id: "d", status: "blocked" }
    });
    const response = await post({ expectedVersion: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      batch: { id, status: "committed" },
      deferred: { id: "d", status: "blocked" },
      state: { areas: [] }
    });
    expect(store.commitReady).toHaveBeenCalledWith(id, 3);
  });

  it("passes a null deferred batch through when nothing was blocked", async () => {
    store.commitReady.mockResolvedValue({ batch: { id, status: "committed" }, deferred: null });
    expect(await (await post({ expectedVersion: 1 })).json()).toMatchObject({ deferred: null });
  });

  it("refuses a body without an expected version before touching the store", async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    expect(store.commitReady).not.toHaveBeenCalled();
  });

  it("answers a stale version as a conflict and any other refusal as a bad request", async () => {
    store.commitReady.mockRejectedValue(new FakeConflictError("This import draft changed elsewhere."));
    expect((await post({ expectedVersion: 2 })).status).toBe(409);
    store.commitReady.mockRejectedValue(new Error("No records are ready to commit."));
    const response = await post({ expectedVersion: 2 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No records are ready to commit." });
  });

  it("answers an agent's commit on the hard floor as forbidden", async () => {
    store.commitReady.mockRejectedValue(new ForbiddenCommandError("An agent token cannot make this write: bulk."));
    expect((await post({ expectedVersion: 2 })).status).toBe(403);
  });
});
