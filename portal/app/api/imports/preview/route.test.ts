import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportBatch } from "@openrhen/contracts";

/**
 * The store is replaced wholesale: what is under test is that a preview the store recognised as an
 * existing batch reaches the browser flagged `reopened`, and one it created does not — the one bit
 * the Inbox needs to tell "reopened that batch" from "here is a new one".
 */
const store = { previewOrReopen: vi.fn() };

vi.mock("@/server/persistence/postgres/import-store", () => ({
  withImportStore: (operation: (value: typeof store) => unknown) => operation(store)
}));

const { POST } = await import("./route");

const batch: ImportBatch = {
  id: "22222222-2222-4222-8222-222222222222",
  sourceType: "csv",
  inputKind: "planning_data",
  timezone: "Australia/Sydney",
  templateVersion: "1",
  status: "ready",
  version: 1,
  records: [],
  source: { filename: "areas.csv", mimeType: "text/csv", contentHash: "a".repeat(64) }
};

const preview = (body: unknown) =>
  POST(
    new Request("http://portal.test/api/imports/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({}) }
  );

const input = {
  sourceType: "csv",
  inputKind: "planning_data",
  timezone: "Australia/Sydney",
  templateVersion: "1",
  records: [],
  source: batch.source
};

beforeEach(() => {
  store.previewOrReopen.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/imports/preview", () => {
  it("answers with the batch and says it was newly created", async () => {
    store.previewOrReopen.mockResolvedValue({ batch, reopened: false });
    const response = await preview(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ batch, reopened: false });
    expect(store.previewOrReopen).toHaveBeenCalledWith(expect.objectContaining({ source: batch.source }));
  });

  it("says when the store reopened a batch that already held this content", async () => {
    store.previewOrReopen.mockResolvedValue({ batch, reopened: true });
    const response = await preview(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reopened: true, batch: { id: batch.id } });
  });

  it("refuses a body that is not a preview without asking the store", async () => {
    const response = await preview({ sourceType: "csv" });
    expect(response.status).toBe(400);
    expect(store.previewOrReopen).not.toHaveBeenCalled();
  });
});
