import { describe, expect, it } from "vitest";
import { importBatchSchema } from "@openrhen/contracts";
import { convertImportCell, createImportCsvTemplate, parseImportCsv, parsePathwayGroups } from "./import-csv";
import { describeImportRecordSource } from "./import-record-source";
import { importSpecs } from "./import-spec";
import { validateImportRecords } from "@/features/imports/import-validation";
import { FixtureImportExtractor } from "@/server/imports/import-extractor";
import { GET as getCsvTemplate } from "@/app/api/imports/templates/[entity]/route";

describe("Import Centre contracts", () => {
  it("parses quoted CSV and preserves blank required fields as missing", () => {
    const records = parseImportCsv(
      "areas",
      'import_key,name,description,status,sort_order\r\nstudy,"Study, training",,active,0\r\nmissing,,,active,1'
    );
    expect(records[0]?.fields.name?.value).toBe("Study, training");
    expect(records[1]?.fields.name).toMatchObject({ value: null, basis: "missing", needsReview: true });
    expect(validateImportRecords(records)[1]?.errors).toContain("name is required.");
  });

  it("round-trips explicit, inferred, default and missing field evidence", () => {
    const record = parseImportCsv(
      "areas",
      "import_key,name,description,status,sort_order\r\nstudy,Study,,active,0"
    )[0]!;
    record.fields.description = {
      value: "Learning",
      basis: "inferred",
      confidence: "medium",
      evidence: ["Line 2"],
      needsReview: true
    };
    record.fields.status = {
      value: "active",
      basis: "default",
      confidence: null,
      evidence: ["Applied by user"],
      needsReview: false
    };
    const result = importBatchSchema.parse({
      id: crypto.randomUUID(),
      sourceType: "fixture",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      status: "ready",
      version: 1,
      records: [record],
      source: {}
    });
    expect(result.records[0]?.fields.description).toMatchObject({ basis: "inferred", confidence: "medium" });
    expect(result.records[0]?.fields.status?.basis).toBe("default");
    expect(result.records[0]?.fields.name?.basis).toBe("explicit");
  });

  it("defines a provider-neutral extractor without external calls", async () => {
    const records = parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nstudy,Study,,active,0");
    const extracted = await new FixtureImportExtractor(records).extract({
      inputKind: "brain_dump",
      timezone: "Australia/Sydney",
      text: "Study",
      currentState: { areas: [], outcomes: [], projects: [], actions: [] }
    });
    expect(extracted).toEqual(records);
    expect(extracted).not.toBe(records);
  });

  it("splits requirement pathways OR-across-| and AND-within-+", () => {
    expect(parsePathwayGroups("desktop+online | college")).toEqual([["desktop", "online"], ["college"]]);
    expect(parsePathwayGroups("laptop")).toEqual([["laptop"]]);
  });

  it("preserves an empty pathway group instead of silently dropping it", () => {
    expect(parsePathwayGroups("desktop | | college")).toEqual([["desktop"], [], ["college"]]);
  });

  it("wraps parsed requirement pathways with a generated id, in row order", () => {
    const parsed = convertImportCell("desktop+online | college", "requirements", importSpecs.actions!);
    expect(parsed).toEqual([
      { id: "p1", contextIds: ["desktop", "online"] },
      { id: "p2", contextIds: ["college"] }
    ]);
  });

  it("parses a condition definition's own composite pathways as raw groups, not wrapped objects", () => {
    expect(convertImportCell("desktop+online | laptop+online", "pathways", importSpecs.conditions!)).toEqual([
      ["desktop", "online"],
      ["laptop", "online"]
    ]);
  });

  it("keeps the legacy contexts column and prefers as plain pipe lists on the actions spec", () => {
    expect(convertImportCell("home|laptop", "contexts", importSpecs.actions!)).toEqual(["home", "laptop"]);
    expect(convertImportCell("home|quiet", "prefers", importSpecs.actions!)).toEqual(["home", "quiet"]);
  });

  it("reads a cadence's interval as a number, and tells a blank cell from a missing column", () => {
    const columns = "import_key,project_key,title,repeat_every_days";
    const [practice, oneOff] = parseImportCsv("actions", `${columns}\r\nrun,fitness,Run,3\r\nfile,fitness,File tax,`);
    expect(practice?.fields.repeatEveryDays).toMatchObject({ value: 3, basis: "explicit", source: "cell" });
    expect(oneOff?.fields.repeatEveryDays).toMatchObject({ value: null, source: "cell" });
    const [absent] = parseImportCsv("actions", `import_key,project_key,title\r\nfile,fitness,File tax`);
    expect(absent?.fields.repeatEveryDays).toMatchObject({ value: null, source: "absent", needsReview: false });
    expect(validateImportRecords([practice!, oneOff!]).flatMap((record) => record.errors)).not.toContain(
      "repeatEveryDays must be a non-negative integer."
    );
  });

  it("parses a deliverable as an unstarted shell and validates its dependency", () => {
    const shell = parseImportCsv(
      "deliverables",
      "import_key,project_key,title,details,status,uncertainty,importance,consequence,internal_deadline_at,external_deadline_at\r\nassessment-2,course,Assessment 2,Read the attached brief,needs_breakdown,some,5,5,,2026-08-28T17:00:00+10:00"
    );
    const dependency = parseImportCsv(
      "deliverable_dependencies",
      "import_key,deliverable_key,depends_on_deliverable_key\r\nafter-one,assessment-2,assessment-1",
      1
    );
    expect(shell[0]).toMatchObject({ entityType: "deliverable", relationships: { projectKey: "course" } });
    expect(shell[0]?.fields).not.toHaveProperty("steps");
    expect(dependency[0]).toMatchObject({
      entityType: "deliverable_dependency",
      relationships: { deliverableKey: "assessment-2", dependsOnDeliverableKey: "assessment-1" }
    });
  });

  it("rejects workbook lifecycle states that would bypass starting BCR from a recommendation", () => {
    const shell = parseImportCsv(
      "deliverables",
      "import_key,project_key,title,details,status,uncertainty,importance,consequence,internal_deadline_at,external_deadline_at\r\nassessment-2,course,Assessment 2,,in_progress,some,5,5,,"
    );
    expect(validateImportRecords(shell)[0]?.errors).toContain(
      "status must be one of: needs_breakdown, cancelled, archived."
    );
  });

  it("parses a CSV Excel saved as UTF-8, whose first header carries a byte-order mark", () => {
    const records = parseImportCsv("areas", "﻿import_key,name,description,status,sort_order\r\nstudy,Study,,active,0");
    expect(records[0]).toMatchObject({ importKey: "study", entityType: "area" });
    expect(records[0]?.fields.name?.value).toBe("Study");
  });

  it("reads an offset-less timestamp in the batch timezone and leaves a zoned one alone", () => {
    const columns =
      "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence,deadline_at";
    const row = "submit,course,Submit,planned,20,30,45,30,medium,20,45,true,5,4,4,";
    const deadline = (deadlineAt: string, timezone?: string) =>
      parseImportCsv("actions", `${columns}\r\n${row}${deadlineAt}`, 0, timezone)[0]?.fields.deadlineAt?.value;

    expect(deadline("2026-08-20T17:00:00", "Australia/Sydney")).toBe("2026-08-20T07:00:00.000Z");
    expect(deadline("2026-12-20T17:00:00", "Australia/Sydney")).toBe("2026-12-20T06:00:00.000Z");
    expect(deadline("2026-08-20T17:00:00", "America/New_York")).toBe("2026-08-20T21:00:00.000Z");
    expect(deadline("2026-08-20T17:00:00", "UTC")).toBe("2026-08-20T17:00:00.000Z");
    expect(deadline("2026-08-20T17:00:00+10:00", "America/New_York")).toBe("2026-08-20T17:00:00+10:00");
    expect(deadline("2026-08-20T17:00:00")).toBe("2026-08-20T17:00:00");
  });

  it("leaves a recurrence's day and clock columns as written, with no zone applied", () => {
    const record = parseImportCsv(
      "fixed_commitment_recurrences",
      "import_key,title,timezone,start_date,end_date,interval_days,local_start_time,local_end_time,setup_before_minutes,transition_after_minutes\r\npiano,Piano lesson,Australia/Sydney,2026-08-14,,14,14:00,15:00,10,15",
      0,
      "Australia/Sydney"
    )[0];
    expect(record?.fields.startDate?.value).toBe("2026-08-14");
    expect(record?.fields.localStartTime?.value).toBe("14:00");
  });

  it("serves deliverable CSV headers from the shared import specification", async () => {
    const deliverables = await getCsvTemplate(new Request("http://local/api/imports/templates/deliverables"), {
      params: Promise.resolve({ entity: "deliverables" })
    });
    const dependencies = await getCsvTemplate(
      new Request("http://local/api/imports/templates/deliverable_dependencies"),
      { params: Promise.resolve({ entity: "deliverable_dependencies" }) }
    );
    expect(deliverables.status).toBe(200);
    expect(await deliverables.text()).toContain(
      "import_key,project_key,title,details,status,uncertainty,importance,consequence,internal_deadline_at,external_deadline_at"
    );
    expect(await dependencies.text()).toContain("import_key,deliverable_key,depends_on_deliverable_key");
  });

  it("assigns record ids on a plain-http origin, where crypto.randomUUID does not exist", () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const csv = "import_key,name,status,sort_order\r\nstudy,Study,active,0";
      const records = parseImportCsv("areas", csv);
      expect(records[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("serves the single-entity route from the shared template builder", async () => {
    const response = await getCsvTemplate(new Request("http://local/api/imports/templates/areas"), {
      params: Promise.resolve({ entity: "areas" })
    });
    expect(await response.text()).toBe(createImportCsvTemplate(importSpecs.areas!));
  });
});

describe("CSV column presence", () => {
  it("records a column the file does not carry as absent, and a blank cell in one it does as a cell", () => {
    const [record] = parseImportCsv("areas", "import_key,name,description\r\nstudy,Study,");
    expect(record?.fields.description).toMatchObject({ value: null, basis: "missing", source: "cell" });
    expect(record?.fields.status).toMatchObject({
      value: null,
      basis: "missing",
      source: "absent",
      needsReview: false
    });
    expect(record?.fields.sortOrder?.source).toBe("absent");
    expect(record?.fields.name).toMatchObject({ value: "Study", source: "cell" });
  });

  it("reads a commitment's place key as a field, with the same absent-versus-blank provenance", () => {
    const header = "import_key,location_key,title,starts_at,ends_at,status";
    const times = "2026-08-10T09:00:00+10:00,2026-08-10T11:00:00+10:00,confirmed";
    const [named, blank] = parseImportCsv(
      "fixed_commitments",
      `${header}\r\nclass,campus,Class,${times}\r\nfree,,Free,${times}`
    );
    expect(named?.fields.locationId).toMatchObject({ value: "campus", basis: "explicit", source: "cell" });
    // A key lives in `fields`, not `relationships`, so it keeps the provenance a relationship cannot.
    expect(named?.relationships.locationId).toBeUndefined();
    expect(blank?.fields.locationId).toMatchObject({ value: null, basis: "missing", source: "cell" });

    const [without] = parseImportCsv(
      "fixed_commitments",
      `import_key,title,starts_at,ends_at,status\r\nclass,Class,${times}`
    );
    expect(without?.fields.locationId).toMatchObject({ value: null, source: "absent", needsReview: false });

    const [rule] = parseImportCsv(
      "fixed_commitment_recurrences",
      "import_key,location_key,title,timezone,start_date,interval_days,local_start_time,local_end_time\r\ntutorial,campus,Tutorial,Australia/Sydney,2026-08-14,7,14:00,15:00"
    );
    expect(rule?.fields.locationId?.value).toBe("campus");
  });

  it("carries the column's provenance through the batch contract unchanged", () => {
    const [record] = parseImportCsv("areas", "import_key,name\r\nstudy,Study");
    const parsed = importBatchSchema.parse({
      id: crypto.randomUUID(),
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      status: "ready",
      version: 1,
      records: [record],
      source: {}
    });
    expect(parsed.records[0]?.fields.status?.source).toBe("absent");
    expect(parsed.records[0]?.fields.name?.source).toBe("cell");
  });
});

describe("CSV row addresses", () => {
  it("keeps the row each record was read from, as the file numbers it", () => {
    const records = parseImportCsv("areas", "import_key,name\r\nstudy,Study\r\nwork,Work");
    expect(describeImportRecordSource(records[0]!)).toBe("Row 2 · Areas");
    expect(describeImportRecordSource(records[1]!)).toBe("Row 3 · Areas");
  });

  it("counts the rows the reader can see, blank and commented lines included", () => {
    const records = parseImportCsv("areas", "# how to fill this in\r\n\r\nimport_key,name\r\n\r\nstudy,Study");
    expect(describeImportRecordSource(records[0]!)).toBe("Row 5 · Areas");
  });

  it("carries the address through the batch contract as an ordinary relationship", () => {
    const [record] = parseImportCsv("areas", "import_key,name\r\nstudy,Study");
    const parsed = importBatchSchema.parse({
      id: crypto.randomUUID(),
      sourceType: "csv",
      inputKind: "planning_data",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      status: "ready",
      version: 1,
      records: [record],
      source: {}
    });
    expect(describeImportRecordSource(parsed.records[0]!)).toBe("Row 2 · Areas");
  });
});

describe("CSV diagnostics", () => {
  it("reports a misspelt column, and reads the rest of the file anyway", () => {
    const diagnostics: string[] = [];
    const records = parseImportCsv("areas", "import_key,name,sort_ordr\r\nstudy,Study,0", 0, undefined, diagnostics);
    expect(records[0]?.fields.name?.value).toBe("Study");
    expect(records[0]?.fields.sortOrder?.source).toBe("absent");
    expect(diagnostics).toEqual([
      'Areas: the column "sort_ordr" is not an import column and was ignored. Did you mean "sort_order"?'
    ]);
  });

  it("reports a row wider than its header row", () => {
    const diagnostics: string[] = [];
    parseImportCsv("areas", "import_key,name\r\nstudy,Study,extra", 0, undefined, diagnostics);
    expect(diagnostics).toEqual(["Areas: row 2 has 3 cells but the header row has 2; the extra values were ignored."]);
  });

  it("says nothing about a file that matches its template", () => {
    const diagnostics: string[] = [];
    parseImportCsv(
      "areas",
      "import_key,name,description,status,sort_order\r\nstudy,Study,,active,0",
      0,
      undefined,
      diagnostics
    );
    expect(diagnostics).toEqual([]);
  });

  it("collects nothing when the caller does not ask", () => {
    expect(() => parseImportCsv("areas", "import_key,name,sort_ordr\r\nstudy,Study,0")).not.toThrow();
  });
});
