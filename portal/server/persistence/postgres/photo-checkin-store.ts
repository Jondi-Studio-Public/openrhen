import {
  DEFAULT_PHOTO_CHECKIN_MODE,
  photoCheckinModeSchema,
  type PhotoCheckinMeta,
  type PhotoCheckinMode,
  type PhotoCheckinWire
} from "@openrhen/contracts";
import {
  checkIns,
  photoCheckins,
  photoCheckinSettings,
  placeReferencePhotos,
  conditionDefinitions
} from "@openrhen/database";
import { InvalidCommandError, notFound, versionConflict } from "./command-errors";
import type { LeftJoined, Row } from "./db-row";
import type { PoolSql } from "./sql-pool";

/**
 * Photo check-ins, record-only. Nothing here reads or writes a `check_in`
 * status, a session, the pulse or the plan: the optional `check_in_id` only says which slot a photo answers.
 * The bytes are in the blob store; a row holds their hash.
 */

type PhotoRow = Row<
  typeof photoCheckins,
  | "id"
  | "taken_at"
  | "check_in_id"
  | "transcript"
  | "description"
  | "edited_by_user"
  | "vlm_description"
  | "agreement"
  | "status"
  | "status_detail"
  | "original_type"
  | "original_bytes"
  | "version"
> &
  // `check_in c` is LEFT JOINed on `p.check_in_id`, so the title is null for a photo sent unprompted.
  LeftJoined<Row<typeof checkIns, "directive_title">> & {
    // Narrowed from `text`: the table's CHECK constraints allow only these values.
    agreement: PhotoCheckinWire["agreement"];
    status: PhotoCheckinWire["status"];
  };

const COLUMNS = `p.id, p.taken_at, p.check_in_id, c.directive_title, p.transcript, p.description, p.edited_by_user,
  p.vlm_description, p.agreement, p.status, p.status_detail, p.original_type, p.original_bytes, p.version`;
const FROM = "photo_checkin p LEFT JOIN check_in c ON c.id = p.check_in_id";

function toWire(row: PhotoRow): PhotoCheckinWire {
  return {
    id: row.id,
    takenAt: row.taken_at.toISOString(),
    checkInId: row.check_in_id,
    directiveTitle: row.directive_title,
    transcript: row.transcript,
    description: row.description,
    editedByUser: row.edited_by_user,
    vlmDescription: row.vlm_description,
    agreement: row.agreement,
    status: row.status,
    statusDetail: row.status_detail,
    originalType: row.original_type,
    originalBytes: row.original_bytes,
    version: row.version
  };
}

export async function getPhotoCheckinMode(sql: PoolSql, userId: string): Promise<PhotoCheckinMode> {
  const [row] = await sql<
    Row<typeof photoCheckinSettings, "mode">[]
  >`SELECT mode FROM photo_checkin_settings WHERE user_id = ${userId}`;
  const parsed = photoCheckinModeSchema.safeParse(row?.mode === "shadow" ? "on" : row?.mode);
  return parsed.success ? parsed.data : DEFAULT_PHOTO_CHECKIN_MODE;
}

/** How long after one photo the next one is asked for; the plan's hourly rich check-in. */
export const PHOTO_PROMPT_INTERVAL_MINUTES = 60;

/**
 * Whether an open check-in should also ask for a photo: unless the person has muted photo check-ins, and no photo was taken in the last hour. It reads the photo
 * rows only, so a skipped hour never builds a backlog; the next open check-in simply asks once.
 */
export async function photoPromptDue(sql: PoolSql, userId: string, now: Date): Promise<boolean> {
  if ((await getPhotoCheckinMode(sql, userId)) !== "on") return false;
  const since = new Date(now.getTime() - PHOTO_PROMPT_INTERVAL_MINUTES * 60_000);
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM photo_checkin WHERE user_id = ${userId} AND taken_at >= ${since}`;
  return (row?.n ?? 0) === 0;
}

/** The only place the mode changes, and only on the person's request. */
export async function setPhotoCheckinMode(sql: PoolSql, userId: string, mode: PhotoCheckinMode): Promise<void> {
  await sql`
    INSERT INTO photo_checkin_settings (user_id, mode) VALUES (${userId}, ${mode})
    ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
}

export interface IngestInput {
  meta: PhotoCheckinMeta;
  originalHash: string;
  originalBytes: number;
  originalType: string;
}

/**
 * Records one photo. `off` receives nothing (the caller refuses before storing a blob); `on` records it
 * `pending`, since processing is the pipeline's job and it never surfaces to the plan. The same photo sent twice returns the existing row, so a retried upload is harmless.
 */
export async function ingestPhotoCheckin(
  sql: PoolSql,
  userId: string,
  input: IngestInput
): Promise<{ photo: PhotoCheckinWire; duplicate: boolean }> {
  if ((await getPhotoCheckinMode(sql, userId)) === "off") throw new InvalidCommandError("Photo check-ins are off.");
  let checkInId: string | null = null;
  if (input.meta.checkInId) {
    const [slot] = await sql<{ id: string }[]>`
      SELECT id FROM check_in WHERE id = ${input.meta.checkInId} AND user_id = ${userId}`;
    if (!slot) throw notFound("check-in", input.meta.checkInId);
    checkInId = slot.id;
  }
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO photo_checkin
      (user_id, check_in_id, taken_at, original_hash, original_bytes, original_type, transcript, description)
    VALUES (${userId}, ${checkInId}, ${input.meta.takenAt}, ${input.originalHash}, ${input.originalBytes},
            ${input.originalType}, ${input.meta.transcript}, ${input.meta.transcript})
    ON CONFLICT (user_id, original_hash) DO NOTHING
    RETURNING id`;
  if (inserted[0]) return { photo: (await getPhotoCheckin(sql, userId, inserted[0].id))!, duplicate: false };
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM photo_checkin WHERE user_id = ${userId} AND original_hash = ${input.originalHash}`;
  return { photo: (await getPhotoCheckin(sql, userId, existing!.id))!, duplicate: true };
}

/** Newest first. `before` pages by `taken_at`. */
export async function listPhotoCheckins(
  sql: PoolSql,
  userId: string,
  options: { limit?: number; before?: string | undefined } = {}
): Promise<PhotoCheckinWire[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const rows = options.before
    ? await sql<PhotoRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM ${sql.unsafe(FROM)}
        WHERE p.user_id = ${userId} AND p.taken_at < ${options.before}
        ORDER BY p.taken_at DESC LIMIT ${limit}`
    : await sql<PhotoRow[]>`
        SELECT ${sql.unsafe(COLUMNS)} FROM ${sql.unsafe(FROM)}
        WHERE p.user_id = ${userId} ORDER BY p.taken_at DESC LIMIT ${limit}`;
  return rows.map(toWire);
}

export async function getPhotoCheckin(sql: PoolSql, userId: string, id: string): Promise<PhotoCheckinWire | null> {
  const [row] = await sql<PhotoRow[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM ${sql.unsafe(FROM)} WHERE p.id = ${id} AND p.user_id = ${userId}`;
  return row ? toWire(row) : null;
}

/** The hash and type of a photo's original, for serving it back. */
export async function getPhotoOriginal(
  sql: PoolSql,
  userId: string,
  id: string
): Promise<{ hash: string; type: string } | null> {
  const [row] = await sql<Row<typeof photoCheckins, "original_hash" | "original_type">[]>`
    SELECT original_hash, original_type FROM photo_checkin WHERE id = ${id} AND user_id = ${userId}`;
  return row ? { hash: row.original_hash, type: row.original_type } : null;
}

/**
 * The person's own edit of their description. Marks it edited and leaves the pipeline's reading and the
 * transcript untouched: the two readings staying side by side is the point.
 */
export async function editPhotoDescription(
  sql: PoolSql,
  userId: string,
  id: string,
  description: string,
  expectedVersion: number
): Promise<PhotoCheckinWire> {
  const [row] = await sql<{ id: string }[]>`
    UPDATE photo_checkin
    SET description = ${description}, edited_by_user = true, version = version + 1, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND version = ${expectedVersion}
    RETURNING id`;
  if (row) return (await getPhotoCheckin(sql, userId, row.id))!;
  const existing = await getPhotoCheckin(sql, userId, id);
  if (!existing) throw notFound("check-in", id, "Photo check-in");
  throw versionConflict("check-in", id, expectedVersion, existing.version);
}

export interface PlaceReferencePhotoWire {
  id: string;
  placeId: string;
  label: string;
  blobType: string;
  blobBytes: number;
  createdAt: string;
}

type PlacePhotoRow = Row<
  typeof placeReferencePhotos,
  "id" | "place_id" | "label" | "blob_type" | "blob_bytes" | "created_at"
>;

function toPlacePhotoWire(row: PlacePhotoRow): PlaceReferencePhotoWire {
  return {
    id: row.id,
    placeId: row.place_id,
    label: row.label,
    blobType: row.blob_type,
    blobBytes: row.blob_bytes,
    createdAt: row.created_at.toISOString()
  };
}

/**
 * One labelled reference photo of a saved place, taken when the place is created. Refused while the switch
 * is `off`, like a check-in photo, and for a place that is not one of the person's saved locations. The same
 * photo added twice to one place is one row. Record-only: nothing reads these until the embedding stage exists.
 */
export async function addPlaceReferencePhoto(
  sql: PoolSql,
  userId: string,
  input: { placeId: string; hash: string; bytes: number; type: string }
): Promise<{ photo: PlaceReferencePhotoWire; duplicate: boolean }> {
  if ((await getPhotoCheckinMode(sql, userId)) === "off") throw new InvalidCommandError("Photo check-ins are off.");
  const [place] = await sql<Row<typeof conditionDefinitions, "name">[]>`
    SELECT name FROM condition_definitions WHERE user_id = ${userId} AND id = ${input.placeId} AND kind = 'location'`;
  if (!place) throw notFound("place", input.placeId);
  const [existing] = await sql<PlacePhotoRow[]>`
    SELECT id, place_id, label, blob_type, blob_bytes, created_at FROM place_reference_photo
    WHERE user_id = ${userId} AND place_id = ${input.placeId} AND blob_hash = ${input.hash}`;
  if (existing) return { photo: toPlacePhotoWire(existing), duplicate: true };
  const [row] = await sql<PlacePhotoRow[]>`
    INSERT INTO place_reference_photo (user_id, place_id, label, blob_hash, blob_bytes, blob_type)
    VALUES (${userId}, ${input.placeId}, ${place.name}, ${input.hash}, ${input.bytes}, ${input.type})
    RETURNING id, place_id, label, blob_type, blob_bytes, created_at`;
  return { photo: toPlacePhotoWire(row!), duplicate: false };
}

export async function listPlaceReferencePhotos(sql: PoolSql, userId: string): Promise<PlaceReferencePhotoWire[]> {
  const rows = await sql<PlacePhotoRow[]>`
    SELECT id, place_id, label, blob_type, blob_bytes, created_at FROM place_reference_photo
    WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map(toPlacePhotoWire);
}
