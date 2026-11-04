import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The place photo route's framing: nothing stored while off, type read from the bytes, an unknown place refused. */
const env = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test", photoStoreDir: () => env.dir }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
const store = vi.hoisted(() => ({
  getPhotoCheckinMode: vi.fn(),
  addPlaceReferencePhoto: vi.fn(),
  listPlaceReferencePhotos: vi.fn()
}));
vi.mock("@/server/persistence/postgres/photo-checkin-store", () => store);

const route = await import("./route");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const upload = (bytes: Uint8Array, fields: Record<string, string> = { placeId: "desk" }) => {
  const form = new FormData();
  form.set("photo", new File([bytes.slice().buffer as ArrayBuffer], "p.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://localhost/api/place-photos", { method: "POST", body: form });
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "place-photo-route-"));
  env.dir = dir;
  for (const mock of Object.values(store)) mock.mockReset();
  store.getPhotoCheckinMode.mockResolvedValue("on");
  store.addPlaceReferencePhoto.mockResolvedValue({ photo: { id: "r1" }, duplicate: false });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/place-photos", () => {
  it("stores the photo and records it against the place with the type its bytes show", async () => {
    const response = await route.POST(upload(JPEG), undefined);
    expect(response.status).toBe(201);
    expect(store.addPlaceReferencePhoto.mock.calls[0]![2]).toMatchObject({
      placeId: "desk",
      type: "image/jpeg",
      bytes: 8
    });
    expect((await readdir(dir)).length).toBe(1);
  });

  it("stores nothing while the switch is off", async () => {
    store.getPhotoCheckinMode.mockResolvedValue("off");
    expect((await route.POST(upload(JPEG), undefined)).status).toBe(409);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a file that is not a photo and a missing place", async () => {
    expect((await route.POST(upload(Uint8Array.from([1, 2, 3, 4])), undefined)).status).toBe(415);
    expect((await route.POST(upload(JPEG, {}), undefined)).status).toBe(400);
    expect(await readdir(dir)).toEqual([]);
  });
});
