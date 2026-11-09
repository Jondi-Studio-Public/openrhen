import { afterEach, describe, expect, it, vi } from "vitest";
import { saveDriftReason } from "./drift-reason-client";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("drift reason client", () => {
  it("posts the words in the body, never in the address", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { id: "x", created: true }));
    vi.stubGlobal("fetch", fetcher);
    await saveDriftReason("11111111-1111-4111-8111-111111111111", "a loud neighbour", "req-12345678");
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/drift-reasons");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      checkInId: "11111111-1111-4111-8111-111111111111",
      text: "a loud neighbour",
      requestId: "req-12345678"
    });
  });

  it("throws the portal's own sentence, or one naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(400, { error: "The reason is empty." })));
    await expect(saveDriftReason("c", "t", "req-12345678")).rejects.toThrow("The reason is empty.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(saveDriftReason("c", "t", "req-12345678")).rejects.toThrow(/answered 500/);
  });

  it("says the portal could not be reached when the request itself fails, without the words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const failure = await saveDriftReason("c", "private words", "req-12345678").catch((error: Error) => error);
    expect((failure as Error).message).toBe("Could not reach the portal. Try again.");
  });
});
