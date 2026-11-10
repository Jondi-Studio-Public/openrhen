import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_VIEW_TYPES } from "@openrhen/contracts";
import { createSeedState, type PortalState } from "@/state/portal-state";

const holder = vi.hoisted(() => ({ state: null as PortalState | null, db: "postgres://test" as string | undefined }));
const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ get: async () => holder.state }) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => holder.db }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/readers/check-in-read", () => ({ readCurrentCheckIn: reader.read }));

const { GET } = await import("./route");

const get = (query = "", headers?: HeadersInit) =>
  GET(new Request(`http://portal.test/api/client/view${query}`, headers ? { headers } : {}), undefined);

beforeEach(() => {
  holder.state = createSeedState(new Date("2026-11-10T09:00:00.000Z")) as unknown as PortalState;
  holder.db = "postgres://test";
  reader.read.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /api/client/view", () => {
  it("answers all three parts by default, in the published shape, never cached", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["now", "day", "pending"]));
    expect(CLIENT_VIEW_TYPES.ClientView.safeParse(body).success).toBe(true);
  });

  it("reads the waiting check-in without stamping prompted_at, so a widget refresh does not start its timeout", async () => {
    reader.read.mockResolvedValue({
      id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11",
      version: 1,
      slotAt: "2026-11-10T08:55:00.000Z",
      promptedAt: null,
      directiveKind: "action",
      directiveTargetId: null,
      directivePhase: null,
      directiveTitle: "Write section 2",
      status: "pending"
    });
    const body = await (await get("?parts=pending")).json();
    expect(reader.read).toHaveBeenCalledWith({}, "user-1", { stamp: false });
    expect(body.pending.checkIn).toMatchObject({ id: "6f0c2c1e-3f5b-4f3a-9b0e-2a6d5f0d9a11", promptedAt: null });
  });

  it("does not touch check-ins when pending is not asked for", async () => {
    const body = await (await get("?parts=now,day")).json();
    expect(reader.read).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty("pending");
  });

  it("answers the rest without a database, with no waiting check-in", async () => {
    holder.db = undefined;
    const body = await (await get()).json();
    expect(reader.read).not.toHaveBeenCalled();
    expect(body.pending.checkIn).toBeNull();
  });

  it("answers 304 with the same ETag when If-None-Match names it, and 200 when it does not", async () => {
    const first = await get();
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    const again = await get("", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    expect((await get("", { "if-none-match": '"stale"' })).status).toBe(200);
  });

  it("gives a different ETag when any part changes", async () => {
    const before = (await get()).headers.get("etag");
    holder.state = {
      ...holder.state!,
      pendingLocationSuggestion: {
        locationId: "studio",
        locationName: "Studio",
        observedAt: "2026-11-10T08:59:00.000Z"
      }
    } as PortalState;
    expect((await get()).headers.get("etag")).not.toBe(before);
  });

  it("refuses an unknown part with 400 and names it", async () => {
    const response = await get("?parts=now,week");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('"week"');
  });

  it("answers 503 when the state is unavailable", async () => {
    holder.state = null;
    expect((await get()).status).toBe(503);
  });
});
