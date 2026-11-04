import type { PortalState } from "@/state/portal-state";
import { redact, withRoute } from "@/server/logging";
import {
  createReferencePackGuide,
  parseReferencePackMode,
  parseReferencePackScopes,
  referencePackGuideFilename,
  selectReferencePack
} from "@/server/imports/reference-pack";
import { getStateStore } from "@/server/persistence/state-store";

export const GET = withRoute("/api/imports/reference-pack-guide", async (request, _context, log) => {
  try {
    const state = (await getStateStore().get()) as PortalState | null;
    if (!state) return Response.json({ error: "Planning state is unavailable." }, { status: 503 });
    const searchParams = new URL(request.url).searchParams;
    const mode = parseReferencePackMode(searchParams);
    const selection = selectReferencePack(state, parseReferencePackScopes(searchParams));
    return new Response(createReferencePackGuide(selection.scopeLabel, mode), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${referencePackGuideFilename(selection.slug, mode)}"`,
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "Reference guide could not be created." },
      { status: 400 }
    );
  }
});
