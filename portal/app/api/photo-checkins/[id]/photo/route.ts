import { notFoundResponse } from "@/server/not-found-response";
import { withRoute } from "@/server/logging";
import { getPhotoOriginal } from "@/server/persistence/postgres/photo-checkin-store";
import { isUuid, planMapContext } from "@/server/plan-map/route-support";
import { getBlob } from "@/server/photos/photo-store";
import { photoStoreDir } from "@/server/runtime-env";

type Params = { params: Promise<{ id: string }> };

/** The original photo's bytes. 410 when the row exists but the blob folder does not hold it (a restore without it). */
export const GET = withRoute("/api/photo-checkins/[id]/photo", async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const dir = photoStoreDir();
  if (!dir) return Response.json({ error: "Photo storage is not configured." }, { status: 503 });
  if (!isUuid(id)) return notFoundResponse("photo", id);
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const original = await getPhotoOriginal(context.sql, context.userId, id);
  if (!original) return notFoundResponse("photo", id);
  const bytes = await getBlob(dir, original.hash);
  if (!bytes) return Response.json({ error: "This photo's file is missing from the store." }, { status: 410 });
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "content-type": original.type,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
});
