import { notFoundResponse } from "@/server/not-found-response";
import { redact, withRoute } from "@/server/logging";
import { withDeliverableProposalStore } from "@/server/persistence/postgres/deliverable-proposal-store";

export const GET = withRoute(
  "/api/deliverable-source-files/[id]",
  async (_request: Request, { params }: { params: Promise<{ id: string }> }, log) => {
    try {
      const { id } = await params;
      const file = await withDeliverableProposalStore((store) => store.getFile(id));
      if (!file) return notFoundResponse("source file", id);
      const disposition =
        file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ? "attachment"
          : "inline";
      return new Response(file.bytes.slice().buffer as ArrayBuffer, {
        headers: {
          "content-type": file.mimeType,
          "content-length": String(file.bytes.byteLength),
          "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff"
        }
      });
    } catch (error) {
      log.setError(error);
      return Response.json(
        { error: error instanceof Error ? redact(error.message) : "Source file could not be loaded." },
        { status: 400 }
      );
    }
  }
);
