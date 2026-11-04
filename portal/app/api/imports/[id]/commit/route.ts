import { commitImportSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { ForbiddenCommandError } from "@/server/persistence/postgres/command-errors";
import { ImportConflictError, withImportStore } from "@/server/persistence/postgres/import-store";
import { getStateStore } from "@/server/persistence/state-store";
import { requestCalendarPublish } from "@/server/imports/calendar-providers";

export const POST = withRoute(
  "/api/imports/[id]/commit",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const parsed = commitImportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Import commit validation failed." }, { status: 400 });
    try {
      const { id } = await params;
      const batch = await withImportStore((store) => store.commit(id, parsed.data.expectedVersion));
      // An import commit does not notify state_changed, so the family calendar hears about it here.
      requestCalendarPublish();
      return Response.json({ batch, state: await getStateStore().get() });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "Import commit failed." },
        { status: error instanceof ImportConflictError ? 409 : error instanceof ForbiddenCommandError ? 403 : 400 }
      );
    }
  }
);
