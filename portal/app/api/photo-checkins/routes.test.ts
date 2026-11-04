import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The photo check-in routes' own framing: refuse before storing while off, read the type from the bytes,
 * and only ever store a recognised photo. The store functions are replaced (they have an integration test).
 */
const env = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test", photoStoreDir: () => env.dir }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
const store = vi.hoisted(() => ({
  getPhotoCheckinMode: vi.fn(),
  ingestPhotoCheckin: vi.fn(),
  listPhotoCheckins: vi.fn(),
  setPhotoCheckinMode: vi.fn()
}));
vi.mock("@/server/persistence/postgres/photo-checkin-store", () => store);

const collection = await import("./route");
const mode = await import("./mode/route");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const upload = (bytes: Uint8Array, fields: Record<string, string> = { takenAt: "2026-10-02T03:00:00Z" }) => {
  const form = new FormData();
  form.set("photo", new File([bytes.slice().buffer as ArrayBuffer], "p.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://localhost/api/photo-checkins", { method: "POST", body: form });
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "photo-route-"));
  env.dir = dir;
  for (const mock of Object.values(store)) mock.mockReset();
  store.getPhotoCheckinMode.mockResolvedValue("on");
  store.ingestPhotoCheckin.mockImplementation(async (_sql, _user, input) => ({
    photo: { id: "p1", originalType: input.originalType },
    duplicate: false
  }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/photo-checkins", () => {
  it("stores a photo and records it with the type its bytes show", async () => {
    const response = await collection.POST(upload(JPEG), undefined);
    expect(response.status).toBe(201);
    expect(store.ingestPhotoCheckin.mock.calls[0]![2]).toMatchObject({ originalType: "image/jpeg", originalBytes: 8 });
    expect((await readdir(dir)).length).toBe(1);
  });

  it("refuses while the switch is off and stores nothing", async () => {
    store.getPhotoCheckinMode.mockResolvedValue("off");
    const response = await collection.POST(upload(JPEG), undefined);
    expect(response.status).toBe(409);
    expect(await readdir(dir)).toEqual([]);
    expect(store.ingestPhotoCheckin).not.toHaveBeenCalled();
  });

  it("refuses a file that is not a photo, whatever it claims to be", async () => {
    const response = await collection.POST(upload(new TextEncoder().encode("<html></html>")), undefined);
    expect(response.status).toBe(415);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a request with no timestamp, and a body declared too large, before reading it", async () => {
    expect((await collection.POST(upload(JPEG, {}), undefined)).status).toBe(400);
    const big = new Request("http://localhost/api/photo-checkins", {
      method: "POST",
      headers: { "content-length": String(40 * 1024 * 1024) },
      body: new FormData()
    });
    expect((await collection.POST(big, undefined)).status).toBe(413);
  });

  it("is unavailable with no store folder configured", async () => {
    env.dir = undefined;
    expect((await collection.POST(upload(JPEG), undefined)).status).toBe(503);
  });
});

describe("the mode route", () => {
  it("changes the mode only on an explicit PUT with a valid mode", async () => {
    const put = (body: unknown) =>
      new Request("http://localhost/api/photo-checkins/mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    expect((await mode.PUT(put({ mode: "loud" }), undefined)).status).toBe(400);
    expect(store.setPhotoCheckinMode).not.toHaveBeenCalled();
    expect((await mode.PUT(put({ mode: "on" }), undefined)).status).toBe(200);
    expect(store.setPhotoCheckinMode).toHaveBeenCalledWith({}, "user-1", "on");
  });
});
