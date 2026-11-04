import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createImportTemplateGuide } from "./import-guide";
import { importSpecs } from "./import-spec";

const guidePath = resolve(__dirname, "../../public/import-template-guide.md");

describe("import template guide", () => {
  it("is the checked-in copy of what the import spec generates (UPDATE_IMPORT_GUIDE=1 rewrites it)", () => {
    const generated = createImportTemplateGuide();
    if (process.env.UPDATE_IMPORT_GUIDE) writeFileSync(guidePath, generated);
    const checkedIn = readFileSync(guidePath, "utf8").replaceAll("\r\n", "\n");
    expect(checkedIn).toBe(generated);
  });

  it("documents every template with its columns, required marks and allowed values", () => {
    const guide = createImportTemplateGuide();
    for (const [entity, spec] of Object.entries(importSpecs)) {
      expect(guide).toContain(`## ${entity}.csv`);
      for (const relation of spec.relations)
        expect(guide).toContain(`| ${relation.header} | ${relation.required ? "yes" : "no"} |`);
      for (const column of spec.columns) {
        expect(guide).toContain(`| ${column.header} | ${column.required ? "yes" : "no"} |`);
        if (column.enum) expect(guide).toContain(column.enum.join(", "));
      }
    }
    expect(guide).toContain("| status | yes | needs_breakdown, cancelled, archived |");
    expect(guide).toContain("| splittable | yes | true or false |");
    expect(guide).toContain("## conditions.csv");
  });
});
