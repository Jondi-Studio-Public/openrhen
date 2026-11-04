import "@/test/example-calendar-sources";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportBatch } from "@openrhen/contracts";
import {
  commitImportBatch,
  commitReadyImportBatch,
  deleteImportBatch,
  requestAiExtraction,
  requestImportPreview,
  requestCalendarSourcePreview,
  saveImportDraft
} from "./import-requests";

const batch = {
  id: "22222222-2222-4222-8222-222222222222",
  sourceType: "csv",
  inputKind: "planning_data",
  timezone: "Australia/Sydney",
  templateVersion: "1",
  status: "ready",
  version: 2,
  records: [],
  source: {}
} as ImportBatch;

function stubFetch(response: { ok: boolean; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: response.ok, json: async () => response.body });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("requestImportPreview", () => {
  it("sends the fixed planning-data envelope and returns the batch", async () => {
    const calls = stubFetch({ ok: true, body: { batch } });
    const result = await requestImportPreview({
      sourceType: "xlsx",
      timezone: "Australia/Sydney",
      records: [],
      source: { filename: "plan.xlsx", mimeType: "application/xlsx", contentHash: "abc" }
    });
    expect(result).toEqual({ batch, reopened: false });
    expect(calls[0]!.url).toBe("/api/imports/preview");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      sourceType: "xlsx",
      inputKind: "planning_data",
      templateVersion: "1"
    });
  });

  it("reports when the server reopened a batch that already held this content", async () => {
    stubFetch({ ok: true, body: { batch, reopened: true } });
    const result = await requestImportPreview({
      sourceType: "csv",
      timezone: "Australia/Sydney",
      records: [],
      source: { filename: "a.csv", mimeType: "text/csv", contentHash: "abc" }
    });
    expect(result.reopened).toBe(true);
    expect(result.batch).toEqual(batch);
  });

  it("throws the server's message when the preview is refused", async () => {
    stubFetch({ ok: false, body: { error: "Template version is not supported." } });
    await expect(
      requestImportPreview({
        sourceType: "csv",
        timezone: "Australia/Sydney",
        records: [],
        source: { filename: "a.csv", mimeType: "text/csv", contentHash: "abc" }
      })
    ).rejects.toThrow("Template version is not supported.");
  });
});

describe("requestAiExtraction", () => {
  it("falls back to a generic message when the server gives none", async () => {
    stubFetch({ ok: false, body: {} });
    await expect(
      requestAiExtraction({ inputKind: "brain_dump", timezone: "Australia/Sydney", text: "notes", images: [] })
    ).rejects.toThrow("AI extraction failed.");
  });
});

describe("requestCalendarSourcePreview", () => {
  it("reports an empty preview as a message rather than a batch", async () => {
    stubFetch({ ok: true, body: { message: "No Example Shared calendar events need review." } });
    const result = await requestCalendarSourcePreview("example_shared", "new", "Australia/Sydney");
    expect(result.batch).toBeNull();
    expect(result.message).toBe("No Example Shared calendar events need review.");
  });

  it("throws when the integration itself failed", async () => {
    stubFetch({ ok: false, body: {} });
    await expect(requestCalendarSourcePreview("example_shared", "updates", "Australia/Sydney")).rejects.toThrow(
      "Example Shared calendar preview failed."
    );
  });
});

describe("saveImportDraft and commitImportBatch", () => {
  it("sends the expected version so a stale review cannot overwrite a newer batch", async () => {
    const calls = stubFetch({ ok: true, body: { batch } });
    await saveImportDraft(batch);
    expect(calls[0]!.url).toBe(`/api/imports/${batch.id}`);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body)).expectedVersion).toBe(2);
  });

  it("requires both a batch and the new portal state before a commit counts", async () => {
    stubFetch({ ok: true, body: { batch } });
    await expect(commitImportBatch(batch)).rejects.toThrow("Commit failed.");
  });
});

describe("commitReadyImportBatch", () => {
  it("posts the expected version to the commit-ready route and returns both batches with the state", async () => {
    const deferred = { ...batch, id: "33333333-3333-4333-8333-333333333333", status: "blocked" as const };
    const calls = stubFetch({ ok: true, body: { batch, deferred, state: { areas: [] } } });
    const result = await commitReadyImportBatch(batch);
    expect(calls[0]!.url).toBe(`/api/imports/${batch.id}/commit-ready`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedVersion: 2 });
    expect(result).toEqual({ batch, deferred, state: { areas: [] } });
  });

  it("reads a missing deferred batch as null and still requires the batch and the state", async () => {
    stubFetch({ ok: true, body: { batch, state: { areas: [] } } });
    expect((await commitReadyImportBatch(batch)).deferred).toBeNull();
    vi.unstubAllGlobals();
    stubFetch({ ok: true, body: { batch } });
    await expect(commitReadyImportBatch(batch)).rejects.toThrow("Commit failed.");
  });

  it("throws the server's refusal", async () => {
    stubFetch({ ok: false, body: { error: "No records are ready to commit." } });
    await expect(commitReadyImportBatch(batch)).rejects.toThrow("No records are ready to commit.");
  });
});

describe("deleteImportBatch", () => {
  it("asks the batch's own route to remove it", async () => {
    const calls = stubFetch({ ok: true, body: { deleted: true } });
    await deleteImportBatch(batch.id);
    expect(calls[0]!.url).toBe(`/api/imports/${batch.id}`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("throws the server's refusal, and a generic message when it gives none", async () => {
    stubFetch({ ok: false, body: { error: "Import batch not found." } });
    await expect(deleteImportBatch(batch.id)).rejects.toThrow("Import batch not found.");
    vi.unstubAllGlobals();
    stubFetch({ ok: false, body: {} });
    await expect(deleteImportBatch(batch.id)).rejects.toThrow("The import batch could not be deleted.");
  });

  it("treats a 200 that did not delete anything as a failure rather than success", async () => {
    stubFetch({ ok: true, body: {} });
    await expect(deleteImportBatch(batch.id)).rejects.toThrow("The import batch could not be deleted.");
  });
});

describe("a response that is not JSON", () => {
  const stubText = (status: number, text: string) =>
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status,
        json: async () => JSON.parse(text)
      })
    );

  it("fails a commit with the generic sentence instead of a parse error", async () => {
    stubText(500, "Internal Server Error");
    const failure = await commitImportBatch(batch).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Commit failed.");
  });

  it("fails a ready-only commit the same way", async () => {
    stubText(502, "<html>Bad gateway</html>");
    await expect(commitReadyImportBatch(batch)).rejects.toThrow("Commit failed.");
  });

  it("fails a preview and an AI extraction with their own sentences", async () => {
    stubText(504, "gateway timeout");
    await expect(
      requestImportPreview({
        sourceType: "csv",
        timezone: "Australia/Sydney",
        records: [],
        source: { filename: "a.csv", mimeType: "text/csv", contentHash: "h" }
      })
    ).rejects.toThrow("Preview failed.");
    await expect(
      requestAiExtraction({ inputKind: "brain_dump", timezone: "Australia/Sydney", text: "x", images: [] })
    ).rejects.toThrow("AI extraction failed.");
  });

  it("fails a Example Shared preview with its sentence", async () => {
    stubText(500, "oops");
    await expect(requestCalendarSourcePreview("example_shared", "new", "Australia/Sydney")).rejects.toThrow(
      "Example Shared calendar preview failed."
    );
  });

  it("still reports the server's own message when the body is JSON", async () => {
    stubFetch({ ok: false, body: { error: "Version changed." } });
    await expect(commitImportBatch(batch)).rejects.toThrow("Version changed.");
  });
});
