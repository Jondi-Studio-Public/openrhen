import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkLabels, putWorkLabel } from "./work-label-client";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("work label client", () => {
  it("reads the list with no caching", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { modelConfigured: false, labels: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchWorkLabels()).toEqual({ modelConfigured: false, labels: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/work-labels", { cache: "no-store" });
  });

  it("puts the answer and request id to the area's address", async () => {
    const saved = { areaId: "a/1", value: "work", origin: "corrected", at: null };
    const fetcher = vi.fn().mockResolvedValue(reply(200, saved));
    vi.stubGlobal("fetch", fetcher);
    expect(await putWorkLabel("a/1", "work", "req-12345678")).toEqual(saved);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/work-labels/a%2F1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ label: "work", requestId: "req-12345678" });
  });

  it("throws the portal's own sentence, or one naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(404, { error: "That area is not here." })));
    await expect(putWorkLabel("a1", "work", "req-12345678")).rejects.toThrow("That area is not here.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(fetchWorkLabels()).rejects.toThrow(/answered 500/);
  });
});
