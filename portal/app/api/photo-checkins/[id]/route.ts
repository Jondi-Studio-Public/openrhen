import { notFoundResponse } from "@/server/not-found-response";
import { photoCheckinEditSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { CommandConflictError, InvalidCommandError } from "@/server/persistence/postgres/command-errors";
import { editPhotoDescription, getPhotoCheckin } from "@/server/persistence/postgres/photo-checkin-store";
import { isUuid, parseBody, planMapContext } from "@/server/plan-map/route-support";

type Params = { params: Promise<{ id: string }> };

export const GET = withRoute("/api/photo-checkins/[id]", async (_request: Request, { params }: Params) => {
  const { id } = await params;
  if (!isUuid(id)) return notFoundResponse("photo check-in", id);
  const context = await planMapContext();
  if (context instanceof Response) return context;
  const photo = await getPhotoCheckin(context.sql, context.userId, id);
  if (!photo) return notFoundResponse("photo check-in", id);
  return Response.json({ photo }, { headers: { "cache-control": "private, no-store" } });
});

/** The person edits their own description. The pipeline's reading is never edited. */
export const PATCH = withRoute("/api/photo-checkins/[id]", async (request: Request, { params }: Params) => {
  const { id } = await params;
  if (!isUuid(id)) return notFoundResponse("photo check-in", id);
  const body = await parseBody(request, photoCheckinEditSchema);
  if (body instanceof Response) return body;
  const context = await planMapContext();
  if (context instanceof Response) return context;
  try {
    const photo = await editPhotoDescription(
      context.sql,
      context.userId,
      id,
      body.data.description,
      body.data.expectedVersion
    );
    return Response.json({ photo });
  } catch (error) {
    if (error instanceof CommandConflictError) return Response.json({ error: redact(error.message) }, { status: 409 });
    if (error instanceof InvalidCommandError) return Response.json({ error: redact(error.message) }, { status: 404 });
    throw error;
  }
});
