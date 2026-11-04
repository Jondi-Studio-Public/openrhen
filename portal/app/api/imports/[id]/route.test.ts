import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The store is replaced wholesale so the route can be exercised without a database: what is under
 * test is the translation from "the store removed nothing" to a 404, and from a refusal to a 409,
 * which is the part a browser sees and the part no integration test of the store itself covers.
 */
class FakeConflictError extends Error {}
const store = { delete: vi.fn() };

vi.mock("@/server/persistence/postgres/import-store", () => ({
  ImportConflictError: FakeConflictError,
  withImportStore: (operation: (value: typeof store) => unknown) => operation(store)
}));

const { DELETE } = await import("./route");

const remove = (id: string) =>
  DELETE(new Request(`http://portal.test/api/imports/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id })
  });

beforeEach(() => {
  store.delete.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE /api/imports/[id]", () => {
  it("removes the batch it was given", async () => {
    store.delete.mockResolvedValue(true);
    const response = await remove("22222222-2222-4222-8222-222222222222");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    // A person discarding a batch: a Google Calendar batch remembers what was declined.
    expect(store.delete).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", { recordDismissals: true });
  });

  it("answers 404 for an id that is not a batch of this user's", async () => {
    store.delete.mockResolvedValue(false);
    const response = await remove("11111111-1111-4111-8111-111111111111");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.stringContaining(" no longer exists, or never existed") });
  });

  it("passes a refusal on as a conflict rather than a not-found", async () => {
    store.delete.mockRejectedValue(new FakeConflictError("A committed batch is a record."));
    const response = await remove("33333333-3333-4333-8333-333333333333");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A committed batch is a record." });
  });
});
