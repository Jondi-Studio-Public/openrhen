import type { PortalState } from "@/state/portal-state";
import { redact, withRoute } from "@/server/logging";
import {
  parseReferencePackMode,
  parseReferencePackScopes,
  referenceKeyCandidates,
  referencePackArchiveFilename,
  selectReferencePack
} from "@/server/imports/reference-pack";
import { createReferencePackArchive } from "@/server/imports/reference-pack-archive";
import { withImportStore } from "@/server/persistence/postgres/import-store";
import { getStateStore } from "@/server/persistence/state-store";

export const GET = withRoute("/api/imports/reference-pack.zip", async (request, _context, log) => {
  try {
    const state = (await getStateStore().get()) as PortalState | null;
    if (!state) return Response.json({ error: "Planning state is unavailable." }, { status: 503 });
    const searchParams = new URL(request.url).searchParams;
    const mode = parseReferencePackMode(searchParams);
    const selection = selectReferencePack(state, parseReferencePackScopes(searchParams));
    const keys = await withImportStore((store) => store.ensureReferenceKeys(referenceKeyCandidates(selection)));
    const archive = await createReferencePackArchive(selection, keys, mode);
    return new Response(archive.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${referencePackArchiveFilename(selection.slug, mode)}"`,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "Reference pack could not be created." },
      { status: 400 }
    );
  }
});
