#!/usr/bin/env node
// Offline alternative to downloading the round-trip reference pack through the browser. Fetches the
// same generator the API route calls (the portal must be running — this script does not import
// portal server code directly, since portal's "@/" path alias is resolved by Vite/vinext, not by a
// plain Node process), saves the workbook, then splits every addition sheet into its own CSV so the
// pack can be reviewed or edited without Excel.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";

const portalUrl = process.env.PORTAL_URL ?? "http://localhost:3000";
const scope = process.argv[2] ?? "scope=all";
const outDir = resolve(process.cwd(), "..", "var", "export-data");

async function main() {
  const url = `${portalUrl.replace(/\/$/, "")}/api/imports/reference-pack?mode=roundtrip&${scope}`;
  console.log(`Fetching ${url} ...`);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Could not reach the portal at ${portalUrl}. Start it with "pnpm dev" first, or set PORTAL_URL. (${error instanceof Error ? error.message : error})`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Reference pack request failed (${response.status}): ${body}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  await mkdir(outDir, { recursive: true });
  const workbookPath = resolve(outDir, "openrhen-roundtrip.xlsx");
  await writeFile(workbookPath, bytes);
  console.log(`Wrote ${workbookPath}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (const sheet of workbook.worksheets) {
    if (sheet.name === "Instructions" || sheet.name.startsWith("Reference")) continue;
    const csvPath = resolve(outDir, `${sheet.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`);
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      for (let column = 1; column <= row.cellCount; column += 1) values.push(csvCell(row.getCell(column).text ?? ""));
      rows.push(values.join(","));
    });
    await writeFile(csvPath, rows.join("\r\n") + "\r\n", "utf8");
    console.log(`Wrote ${csvPath}`);
  }
}

function csvCell(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
