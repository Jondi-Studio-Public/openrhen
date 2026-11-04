import { withRoute } from "@/server/logging";
import { importSpecs } from "@/features/imports/import-spec";
import { createImportCsvTemplate } from "@/features/imports/import-csv";

export const GET = withRoute(
  "/api/imports/templates/[entity]",
  async (_request: Request, { params }: { params: Promise<{ entity: string }> }) => {
    const { entity } = await params;
    const spec = importSpecs[entity];
    if (!spec) return Response.json({ error: "Unknown import template." }, { status: 404 });
    return new Response(createImportCsvTemplate(spec), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="openrhen-${entity}.csv"`
      }
    });
  }
);
