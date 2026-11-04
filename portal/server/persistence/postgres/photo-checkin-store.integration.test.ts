import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import {
  editPhotoDescription,
  getPhotoCheckin,
  addPlaceReferencePhoto,
  getPhotoCheckinMode,
  ingestPhotoCheckin,
  listPhotoCheckins,
  listPlaceReferencePhotos,
  photoPromptDue,
  setPhotoCheckinMode
} from "./photo-checkin-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_photo_checkins");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const input = (seed: string, extra: { checkInId?: string; transcript?: string; takenAt?: string } = {}) => ({
  meta: {
    takenAt: extra.takenAt ?? "2026-10-02T03:00:00+10:00",
    transcript: extra.transcript ?? "At my desk doing maths",
    ...(extra.checkInId ? { checkInId: extra.checkInId } : {})
  },
  originalHash: hash(seed),
  originalBytes: 1234,
  originalType: "image/jpeg"
});

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE photo_checkin, photo_checkin_settings, place_reference_photo, check_in CASCADE");
});

afterAll(async () => {
  await sql?.end();
});

describe("the photo check-in switch", () => {
  it("reads on until the person mutes it, and receives nothing while off", async () => {
    expect(await getPhotoCheckinMode(sql, userId)).toBe("on");
    await setPhotoCheckinMode(sql, userId, "off");
    expect(await getPhotoCheckinMode(sql, userId)).toBe("off");
    await expect(ingestPhotoCheckin(sql, userId, input("a"))).rejects.toBeInstanceOf(InvalidCommandError);
    const [counted] = await sql<{ count: string }[]>`SELECT count(*) FROM photo_checkin`;
    expect(counted?.count).toBe("0");
  });

  it("is set per request and read back, and a stored shadow reads as on", async () => {
    await setPhotoCheckinMode(sql, userId, "off");
    expect(await getPhotoCheckinMode(sql, userId)).toBe("off");
    await setPhotoCheckinMode(sql, userId, "on");
    expect(await getPhotoCheckinMode(sql, userId)).toBe("on");
    await sql`UPDATE photo_checkin_settings SET mode = 'shadow' WHERE user_id = ${userId}`;
    expect(await getPhotoCheckinMode(sql, userId)).toBe("on");
  });
});

describe("ingestPhotoCheckin", () => {
  beforeEach(async () => {
    await setPhotoCheckinMode(sql, userId, "on");
  });

  it("records a pending photo seeded with the transcript as the person's own description", async () => {
    const { photo, duplicate } = await ingestPhotoCheckin(sql, userId, input("a"));
    expect(duplicate).toBe(false);
    expect(photo).toMatchObject({
      status: "pending",
      transcript: "At my desk doing maths",
      description: "At my desk doing maths",
      directiveTitle: null,
      editedByUser: false,
      vlmDescription: null,
      agreement: null,
      version: 1
    });
  });

  it("returns the existing row when the same photo is sent again", async () => {
    const first = await ingestPhotoCheckin(sql, userId, input("a"));
    const second = await ingestPhotoCheckin(sql, userId, input("a", { transcript: "different" }));
    expect(second.duplicate).toBe(true);
    expect(second.photo.id).toBe(first.photo.id);
    expect(second.photo.transcript).toBe("At my desk doing maths");
  });

  it("is record-only: a photo answering a check-in leaves that check-in exactly as it was", async () => {
    const [slot] = await sql<{ id: string; status: string; version: number; answered_at: Date | null }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title)
      VALUES (${userId}, now(), 'action', 'Study maths') RETURNING id, status, version, answered_at`;
    const { photo } = await ingestPhotoCheckin(sql, userId, input("a", { checkInId: slot!.id }));
    expect(photo.checkInId).toBe(slot!.id);
    expect(photo.directiveTitle).toBe("Study maths");
    const [after] = await sql<{ status: string; version: number; answered_at: Date | null }[]>`
      SELECT status, version, answered_at FROM check_in WHERE id = ${slot!.id}`;
    expect(after).toEqual({ status: slot!.status, version: slot!.version, answered_at: slot!.answered_at });
    const [logged] = await sql<{ changes: string }[]>`SELECT count(*) AS changes FROM write_rows`;
    expect(logged?.changes).toBe("0");
  });

  it("refuses a check-in that does not exist", async () => {
    await expect(
      ingestPhotoCheckin(sql, userId, input("a", { checkInId: crypto.randomUUID() }))
    ).rejects.toBeInstanceOf(InvalidCommandError);
  });

  it("lists newest first and pages by taken_at", async () => {
    await ingestPhotoCheckin(sql, userId, input("a", { takenAt: "2026-10-02T01:00:00Z" }));
    await ingestPhotoCheckin(sql, userId, input("b", { takenAt: "2026-10-02T02:00:00Z" }));
    await ingestPhotoCheckin(sql, userId, input("c", { takenAt: "2026-10-02T03:00:00Z" }));
    const all = await listPhotoCheckins(sql, userId);
    expect(all.map((photo) => photo.takenAt)).toEqual([
      "2026-10-02T03:00:00.000Z",
      "2026-10-02T02:00:00.000Z",
      "2026-10-02T01:00:00.000Z"
    ]);
    const older = await listPhotoCheckins(sql, userId, { before: "2026-10-02T02:00:00Z", limit: 5 });
    expect(older).toHaveLength(1);
  });
});

describe("editPhotoDescription", () => {
  beforeEach(async () => {
    await setPhotoCheckinMode(sql, userId, "on");
  });

  it("changes only the person's description and marks it edited", async () => {
    const { photo } = await ingestPhotoCheckin(sql, userId, input("a"));
    await sql`UPDATE photo_checkin SET vlm_description = 'a desk with a laptop' WHERE id = ${photo.id}`;
    const edited = await editPhotoDescription(sql, userId, photo.id, "Doing maths at my desk", 1);
    expect(edited).toMatchObject({
      description: "Doing maths at my desk",
      transcript: "At my desk doing maths",
      vlmDescription: "a desk with a laptop",
      editedByUser: true,
      version: 2
    });
  });

  it("refuses a stale version and an unknown photo", async () => {
    const { photo } = await ingestPhotoCheckin(sql, userId, input("a"));
    await editPhotoDescription(sql, userId, photo.id, "one", 1);
    await expect(editPhotoDescription(sql, userId, photo.id, "two", 1)).rejects.toBeInstanceOf(CommandConflictError);
    await expect(editPhotoDescription(sql, userId, crypto.randomUUID(), "x", 1)).rejects.toBeInstanceOf(
      InvalidCommandError
    );
    expect((await getPhotoCheckin(sql, userId, photo.id))!.description).toBe("one");
  });
});

describe("photoPromptDue", () => {
  const now = new Date("2026-10-02T03:30:00.000Z");

  it("asks unless muted, and only when no photo was taken in the last hour", async () => {
    expect(await photoPromptDue(sql, userId, now)).toBe(true);
    await setPhotoCheckinMode(sql, userId, "off");
    expect(await photoPromptDue(sql, userId, now)).toBe(false);
    await setPhotoCheckinMode(sql, userId, "on");
    expect(await photoPromptDue(sql, userId, now)).toBe(true);
    await ingestPhotoCheckin(sql, userId, input("b", { takenAt: "2026-10-02T03:00:00.000Z" }));
    expect(await photoPromptDue(sql, userId, now)).toBe(false);
    expect(await photoPromptDue(sql, userId, new Date("2026-10-02T04:01:00.000Z"))).toBe(true);
  });
});

describe("place reference photos", () => {
  const add = (placeId: string, seed: string) =>
    addPlaceReferencePhoto(sql, userId, { placeId, hash: hash(seed), bytes: 10, type: "image/jpeg" });

  it("files a photo against a saved location, once, and refuses while off or for another place", async () => {
    await sql`DELETE FROM condition_definitions WHERE user_id = ${userId} AND id IN ('desk', 'trainer')`;
    await sql`INSERT INTO condition_definitions (user_id, id, name, kind) VALUES (${userId}, 'desk', 'Desk', 'location')`;
    await sql`INSERT INTO condition_definitions (user_id, id, name, kind) VALUES (${userId}, 'trainer', 'Trainer', 'contact')`;
    await setPhotoCheckinMode(sql, userId, "off");
    await expect(add("desk", "a")).rejects.toBeInstanceOf(InvalidCommandError);
    await setPhotoCheckinMode(sql, userId, "on");
    const first = await add("desk", "a");
    expect(first.duplicate).toBe(false);
    expect(first.photo).toMatchObject({ placeId: "desk", label: "Desk" });
    expect((await add("desk", "a")).duplicate).toBe(true);
    await expect(add("nowhere", "b")).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(add("trainer", "b")).rejects.toBeInstanceOf(InvalidCommandError);
    expect(await listPlaceReferencePhotos(sql, userId)).toHaveLength(1);
    await sql`DELETE FROM condition_definitions WHERE user_id = ${userId} AND id IN ('desk', 'trainer')`;
  });
});
