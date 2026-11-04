import { withRoute } from "@/server/logging";
import { createImportCsvTemplateArchive } from "@/server/imports/csv-template-archive";

export const GET = withRoute("/api/imports/templates.zip", async () => {
  const archive = await createImportCsvTemplateArchive();
  return new Response(archive.slice().buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="openrhen-csv-templates.zip"',
      "cache-control": "no-store"
    }
  });
});
