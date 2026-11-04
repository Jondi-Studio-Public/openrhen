import { photoCheckinModeInputSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { getPhotoCheckinMode, setPhotoCheckinMode } from "@/server/persistence/postgres/photo-checkin-store";
import { parseBody, planMapContext } from "@/server/plan-map/route-support";

export const GET = withRoute("/api/photo-checkins/mode", async () => {
  const context = await planMapContext();
  if (context instanceof Response) return context;
  return Response.json({ mode: await getPhotoCheckinMode(context.sql, context.userId) });
});

/** Sets the photo check-in switch. The only place it changes, and only on a person's request. */
export const PUT = withRoute("/api/photo-checkins/mode", async (request) => {
  const body = await parseBody(request, photoCheckinModeInputSchema);
  if (body instanceof Response) return body;
  const context = await planMapContext();
  if (context instanceof Response) return context;
  await setPhotoCheckinMode(context.sql, context.userId, body.data.mode);
  return Response.json({ mode: body.data.mode });
});
