import { withRoute } from "@/server/logging";
import { withIssueSnapshotStore } from "@/server/persistence/postgres/issue-snapshot-store";

export const GET = withRoute(
  "/api/snapshots/[id]",
  async (request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    const { id } = await params;
    let snapshot;
    try {
      snapshot = await withIssueSnapshotStore((store) => store.get(id));
    } catch (error) {
      log.setError(error);
      return Response.json({ error: "The issue snapshot could not be read." }, { status: 503 });
    }
    if (!snapshot) return Response.json({ error: "Issue snapshot not found." }, { status: 404 });
    // The portal runs on the Workers runtime and cannot write files, so the download is how a snapshot
    // becomes the file you keep. `scripts/snapshots/export.mjs` fetches this same route.
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(download ? { "content-disposition": `attachment; filename="openrhen-snapshot-${id}.json"` } : {})
      }
    });
  }
);
