import { PHOTO_MAX_BYTES, photoCheckinMetaSchema, sniffPhotoType } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import {
  getPhotoCheckinMode,
  ingestPhotoCheckin,
  listPhotoCheckins
} from "@/server/persistence/postgres/photo-checkin-store";
import { planMapContext } from "@/server/plan-map/route-support";
import { hashBytes, putBlob } from "@/server/photos/photo-store";
import { photoStoreDir } from "@/server/runtime-env";

const NO_STORE = { "cache-control": "private, no-store" };

export const GET = withRoute("/api/photo-checkins", async (request) => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "30");
  const before = url.searchParams.get("before") ?? undefined;
  const photos = await listPhotoCheckins(context.sql, context.userId, {
    limit: Number.isFinite(limit) ? limit : 30,
    before: before && !Number.isNaN(Date.parse(before)) ? before : undefined
  });
  return Response.json({ mode: await getPhotoCheckinMode(context.sql, context.userId), photos }, { headers: NO_STORE });
});

/**
 * Receives one photo and what was said about it, as multipart form data: `photo` (the file), `takenAt`,
 * `transcript` and optionally `checkInId`. Refused while the switch is `off`, before a byte is stored.
 * The type is read from the bytes. Record-only: the row never reaches the plan.
 */
export const POST = withRoute("/api/photo-checkins", async (request, _context, log) => {
  const dir = photoStoreDir();
  if (!dir) return Response.json({ error: "Photo storage is not configured." }, { status: 503 });
  // The cap below trusts content-length; a chunked upload is buffered by formData() before `file.size` is checked.
  // Accepted: this is one person on a private network, and the file-size check still refuses it before anything is stored.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PHOTO_MAX_BYTES + 64 * 1024)
    return Response.json({ error: "That photo is too large." }, { status: 413 });
  const context = await planMapContext();
  if (context instanceof Response) return context;
  if ((await getPhotoCheckinMode(context.sql, context.userId)) === "off") {
    return Response.json({ error: "Photo check-ins are off." }, { status: 409 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Send the photo as multipart form data." }, { status: 400 });
  }
  const file = form.get("photo");
  if (!(file instanceof File)) return Response.json({ error: "A photo file is required." }, { status: 400 });
  if (file.size > PHOTO_MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
  const meta = photoCheckinMetaSchema.safeParse({
    takenAt: form.get("takenAt"),
    transcript: form.get("transcript") ?? "",
    checkInId: form.get("checkInId") || undefined
  });
  if (!meta.success) {
    return Response.json(
      { error: "The request failed validation.", issues: meta.error.issues.slice(0, 20) },
      { status: 400 }
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffPhotoType(bytes);
  if (!type) return Response.json({ error: "That file is not a supported photo." }, { status: 415 });
  try {
    // The blob is written before the row. A check-in that does not exist (409 below) leaves an orphan blob:
    // harmless, since blobs are content-addressed and the same photo sent again reuses it.
    await putBlob(dir, bytes);
    const { photo, duplicate } = await ingestPhotoCheckin(context.sql, context.userId, {
      meta: meta.data,
      originalHash: hashBytes(bytes),
      originalBytes: bytes.byteLength,
      originalType: type
    });
    return Response.json({ photo, duplicate }, { status: duplicate ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    log.setError(error);
    if (error instanceof InvalidCommandError) return Response.json({ error: redact(error.message) }, { status: 409 });
    throw error;
  }
});
