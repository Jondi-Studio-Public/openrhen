import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteReasonAndTags, fetchReasonTags, putReasonTags } from "./reason-tag-client";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ID = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.unstubAllGlobals());

describe("reason tag client", () => {
  it("reads the list without caching", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { modelConfigured: true, reasons: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchReasonTags()).toEqual({ modelConfigured: true, reasons: [] });
    expect(fetcher.mock.calls[0]).toEqual(["/api/drift-reasons", { cache: "no-store" }]);
  });

  it("puts tags, or a reset, in the body of the check-in's own address", async () => {
    const fetcher = vi.fn().mockImplementation(async () => reply(200, { checkInId: ID }));
    vi.stubGlobal("fetch", fetcher);
    await putReasonTags(ID, { tags: ["a phrase"] }, "req-12345678");
    await putReasonTags(ID, { reset: true }, "req-87654321");
    const [first, second] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(first[0]).toBe(`/api/drift-reasons/${ID}/tags`);
    expect(first[1].method).toBe("PUT");
    expect(JSON.parse(first[1].body as string)).toEqual({ tags: ["a phrase"], requestId: "req-12345678" });
    expect(JSON.parse(second[1].body as string)).toEqual({ reset: true, requestId: "req-87654321" });
  });

  it("deletes by check-in id", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { removed: 2 }));
    vi.stubGlobal("fetch", fetcher);
    await deleteReasonAndTags(ID);
    expect(fetcher.mock.calls[0]).toEqual([`/api/drift-reasons/${ID}`, { method: "DELETE" }]);
  });

  it("throws the portal's own sentence, or one naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(400, { error: "Too many tags." })));
    await expect(putReasonTags(ID, { tags: [] }, "req-12345678")).rejects.toThrow("Too many tags.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(fetchReasonTags()).rejects.toThrow(/answered 500/);
    await expect(deleteReasonAndTags(ID)).rejects.toThrow(/answered 500/);
  });

  it("says the portal could not be reached when the request itself fails, without the tags", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    for (const failure of [
      await putReasonTags(ID, { tags: ["private phrase"] }, "req-12345678").catch((error: Error) => error),
      await fetchReasonTags().catch((error: Error) => error),
      await deleteReasonAndTags(ID).catch((error: Error) => error)
    ])
      expect((failure as Error).message).toBe("Could not reach the portal. Try again.");
  });
});
