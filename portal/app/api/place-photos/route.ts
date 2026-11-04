import { PHOTO_MAX_BYTES, sniffPhotoType } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import {
  addPlaceReferencePhoto,
  getPhotoCheckinMode,
  listPlaceReferencePhotos
} from "@/server/persistence/postgres/photo-checkin-store";
import { planMapContext } from "@/server/plan-map/route-support";
import { hashBytes, putBlob } from "@/server/photos/photo-store";
import { photoStoreDir } from "@/server/runtime-env";

const NO_STORE = { "cache-control": "private, no-store" };

export const GET = withRoute("/api/place-photos", async () => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  return Response.json({ photos: await listPlaceReferencePhotos(context.sql, context.userId) }, { headers: NO_STORE });
});

/**
 * Adds one reference photo to a saved place, as multipart form data: `placeId` and `photo`. Refused while the
 * photo switch is `off`. The type is read from the bytes. Record-only, like the check-in photos.
 */
export const POST = withRoute("/api/place-photos", async (request, _context, log) => {
  const dir = photoStoreDir();
  if (!dir) return Response.json({ error: "Photo storage is not configured." }, { status: 503 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PHOTO_MAX_BYTES + 64 * 1024)
    return Response.json({ error: "That photo is too large." }, { status: 413 });
  const context = await planMapContext();
  if (context instanceof Response) return context;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Send the photo as multipart form data." }, { status: 400 });
  }
  const file = form.get("photo");
  const placeId = form.get("placeId");
  if (!(file instanceof File)) return Response.json({ error: "A photo file is required." }, { status: 400 });
  if (typeof placeId !== "string" || !placeId.trim() || placeId.length > 200)
    return Response.json({ error: "A place is required." }, { status: 400 });
  if (file.size > PHOTO_MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffPhotoType(bytes);
  if (!type) return Response.json({ error: "That file is not a supported photo." }, { status: 415 });
  try {
    // Off stores nothing; the blob is written before the row so a row never points at a missing file. An
    // unknown place (409) leaves an orphan blob, harmless since blobs are content-addressed.
    if ((await getPhotoCheckinMode(context.sql, context.userId)) === "off") {
      return Response.json({ error: "Photo check-ins are off." }, { status: 409 });
    }
    await putBlob(dir, bytes);
    const added = await addPlaceReferencePhoto(context.sql, context.userId, {
      placeId,
      hash: hashBytes(bytes),
      bytes: bytes.byteLength,
      type
    });
    return Response.json(added, { status: added.duplicate ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    log.setError(error);
    if (error instanceof InvalidCommandError) return Response.json({ error: redact(error.message) }, { status: 409 });
    throw error;
  }
});
