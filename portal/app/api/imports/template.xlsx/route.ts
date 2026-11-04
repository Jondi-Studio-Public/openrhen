import { withRoute } from "@/server/logging";
import { createImportWorkbook } from "@/features/imports/import-xlsx";

export const GET = withRoute("/api/imports/template.xlsx", async () => {
  const workbook = await createImportWorkbook();
  return new Response(workbook.slice().buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="openrhen-import-template.xlsx"',
      "cache-control": "no-store"
    }
  });
});
