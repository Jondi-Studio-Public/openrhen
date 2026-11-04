import { previewImportSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { withImportStore } from "@/server/persistence/postgres/import-store";

export const POST = withRoute("/api/imports/preview", async (request, _context, log) => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 6_000_000) return Response.json({ error: "Import preview payload is too large." }, { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 6_000_000)
    return Response.json({ error: "Import preview payload is too large." }, { status: 413 });
  let input: unknown = null;
  try {
    input = JSON.parse(body);
  } catch {
    /* validation below returns a safe error */
  }
  const parsed = previewImportSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: "Import preview validation failed.", issues: parsed.error.issues.slice(0, 50) },
      { status: 400 }
    );
  try {
    // A hash the queue already holds reopens that batch; `reopened` lets the browser say so.
    const { batch, reopened } = await withImportStore((store) => store.previewOrReopen(parsed.data));
    return Response.json({ batch, reopened });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "Import preview failed." },
      { status: 400 }
    );
  }
});
