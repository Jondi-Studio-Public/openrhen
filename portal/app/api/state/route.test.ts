import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";

const holder = vi.hoisted(() => ({ current: null as PortalState | null }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.current }) }));

const { GET } = await import("./route");

const get = (headers?: HeadersInit) => GET(new Request("http://portal.test/api/state", headers ? { headers } : {}), {});

beforeEach(() => {
  holder.current = createSeedState(new Date("2026-11-03T10:00:00.000Z"));
});

describe("GET /api/state", () => {
  it("answers the state with a weak ETag and no-cache so the browser revalidates", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^W\/"[\w-]+"$/);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    expect(((await response.json()) as { state: PortalState }).state.settings).toBeDefined();
  });

  it("answers 304 with no body when If-None-Match is the current ETag", async () => {
    const etag = (await get()).headers.get("etag")!;
    const again = await get({ "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("vary")).toBe("Cookie, Authorization");
  });

  it("sends the body when the state changed or the validator is from a compressed copy of another", async () => {
    const etag = (await get()).headers.get("etag")!;
    holder.current = { ...holder.current!, settings: { ...holder.current!.settings, locale: "en-GB" } } as PortalState;
    const changed = await get({ "if-none-match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await get({ "if-none-match": changed.headers.get("etag")!.replace("W/", "") })).status).toBe(304);
  });

  it("still answers a null state (nothing stored yet) with an ETag", async () => {
    holder.current = null;
    const response = await get();
    expect(await response.json()).toEqual({ state: null });
    expect(response.headers.get("etag")).toBeTruthy();
  });
});
