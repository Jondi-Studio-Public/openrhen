import { notFoundResponse } from "@/server/not-found-response";
import { updateImportSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { ImportConflictError, withImportStore } from "@/server/persistence/postgres/import-store";

export const GET = withRoute(
  "/api/imports/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const batch = await withImportStore((store) => store.get(id));
    return batch ? Response.json({ batch }) : notFoundResponse("import batch", id);
  }
);

/**
 * Removes a queued batch from the Inbox. A batch that was previewed and never committed is a draft
 * nobody is going to finish, and until now the only way it left the queue was by being committed —
 * so the list only ever grew.
 */
export const DELETE = withRoute(
  "/api/imports/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const { id } = await params;
    try {
      const deleted = await withImportStore((store) => store.delete(id, { recordDismissals: true }));
      return deleted ? Response.json({ deleted: true }) : notFoundResponse("import batch", id);
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "Import batch could not be deleted." },
        { status: error instanceof ImportConflictError ? 409 : 400 }
      );
    }
  }
);

export const PUT = withRoute(
  "/api/imports/[id]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 6_000_000) return Response.json({ error: "Import draft payload is too large." }, { status: 413 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 6_000_000)
      return Response.json({ error: "Import draft payload is too large." }, { status: 413 });
    let input: unknown = null;
    try {
      input = JSON.parse(body);
    } catch {
      /* validation below returns a safe error */
    }
    const parsed = updateImportSchema.safeParse(input);
    if (!parsed.success)
      return Response.json(
        { error: "Import draft validation failed.", issues: parsed.error.issues.slice(0, 50) },
        { status: 400 }
      );
    try {
      const { id } = await params;
      return Response.json({
        batch: await withImportStore((store) => store.update(id, parsed.data.expectedVersion, parsed.data.records))
      });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "Import draft update failed." },
        { status: error instanceof ImportConflictError ? 409 : 400 }
      );
    }
  }
);
