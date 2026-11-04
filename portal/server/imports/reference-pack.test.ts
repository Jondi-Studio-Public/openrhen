import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { importSpecs } from "@/features/imports/import-spec";
import {
  createReferencePackGuide,
  createReferencePackWorkbook,
  fallbackReferenceKey,
  parseReferencePackMode,
  parseReferencePackScopes,
  referenceKeyCandidates,
  referencePackGuideFilename,
  referencePackWorkbookFilename,
  selectReferencePack,
  type ReferenceKeyMap
} from "./reference-pack";
import { parseImportWorkbook } from "@/features/imports/import-xlsx";

describe("reference packs", () => {
  it("separates authoritative reference rows from empty importable addition sheets", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const project = state.projects[0]!;
    const selection = selectReferencePack(state, [{ type: "project", id: project.id }]);
    const keys = keyMap(selection);
    const bytes = await createReferencePackWorkbook(selection, keys);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer(bytes));

    expect(workbook.getWorksheet("Reference Projects")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Reference Actions")!.rowCount).toBeGreaterThan(1);
    expect(workbook.getWorksheet("Reference Deliverables")).toBeDefined();
    expect(workbook.getWorksheet("Deliverables")?.getRow(2).values).toEqual([]);
    expect(workbook.getWorksheet("Actions")?.getRow(2).values).toEqual([]);
    expect(workbook.getWorksheet("Instructions")?.getCell("B1").text).toContain(project.title);
  });

  it("lets a tool add rows without re-importing reference rows", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const project = state.projects[0]!;
    const selection = selectReferencePack(state, [{ type: "project", id: project.id }]);
    const keys = keyMap(selection);
    const bytes = await createReferencePackWorkbook(selection, keys);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer(bytes));
    workbook
      .getWorksheet("Actions")!
      .addRow([
        "new-action",
        keys.project![project.id],
        "Create the new section outline",
        "planned",
        20,
        30,
        45,
        30,
        "medium",
        15,
        45,
        true,
        5,
        4,
        4,
        "home|laptop",
        "",
        "2026-08-12T17:00:00+10:00",
        ""
      ]);
    const output = new Uint8Array(await workbook.xlsx.writeBuffer());
    const records = await parseImportWorkbook(
      output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      importKey: "new-action",
      entityType: "action",
      relationships: { projectKey: keys.project![project.id] }
    });
  });

  it("lets a tool add a deliverable shell alongside ordinary actions", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const project = state.projects[0]!;
    const selection = selectReferencePack(state, [{ type: "project", id: project.id }]);
    const keys = keyMap(selection);
    const bytes = await createReferencePackWorkbook(selection, keys);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer(bytes));
    workbook
      .getWorksheet("Deliverables")!
      .addRow([
        "assessment-2",
        keys.project![project.id],
        "Assessment 2",
        "Read the brief when work starts",
        "needs_breakdown",
        "some",
        5,
        5,
        "",
        "2026-08-28T17:00:00+10:00"
      ]);
    const output = new Uint8Array(await workbook.xlsx.writeBuffer());
    const records = await parseImportWorkbook(
      output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      importKey: "assessment-2",
      entityType: "deliverable",
      relationships: { projectKey: keys.project![project.id] }
    });
    expect(records[0]?.fields).not.toHaveProperty("steps");
  });

  it("writes each commitment's saved place into the round-trip pack, and explains the column", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    state.commitments = [{ ...state.commitments[0]!, locationId: "campus" }, ...state.commitments.slice(1)];
    const selection = selectReferencePack(state, [{ type: "all" }]);
    const keys = keyMap(selection);
    const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer(bytes));

    for (const sheetName of ["Fixed Commitments", "Reference Fixed Commitments"]) {
      const sheet = workbook.getWorksheet(sheetName)!;
      const headers = (sheet.getRow(1).values as unknown[]).map((value) => String(value ?? ""));
      expect(headers).toContain("location_key");
      expect(sheet.getRow(2).getCell(headers.indexOf("location_key")).text).toBe("campus");
    }
    expect(workbook.getWorksheet("Recurring Commitments")!.getRow(1).values).toContain("location_key");
    const instructions = workbook.getWorksheet("Instructions")!;
    expect(instructions.getColumn(2).values.join(" ")).toContain("location_key on Fixed Commitments");
    expect(createReferencePackGuide()).toContain("`location_key`");
  });

  it("exports the prerequisite edges between records in the pack, and none that leave it", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const [project, otherProject] = state.projects;
    const action = state.actions.find((item) => item.projectId === project!.id)!;
    const outside = state.actions.find((item) => item.projectId !== project!.id)!;
    action.prerequisites = [
      { kind: "project", id: otherProject!.id },
      { kind: "action", id: outside.id }
    ];
    const selection = selectReferencePack(state, [{ type: "all" }]);
    const keys = keyMap(selection);
    const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer(bytes));
    for (const sheetName of ["Entity Prerequisites", "Reference Entity Prerequisites"]) {
      const sheet = workbook.getWorksheet(sheetName)!;
      expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([
        "import_key",
        "entity_kind",
        "entity_key",
        "requires_kind",
        "requires_key"
      ]);
      expect((sheet.getRow(2).values as unknown[]).slice(2)).toEqual([
        "action",
        keys.action![action.id],
        "project",
        keys.project![otherProject!.id]
      ]);
    }
    // The action prerequisite is in the pack too, so it is exported; narrow the scope and it is not.
    const narrow = selectReferencePack(state, [{ type: "project", id: project!.id }]);
    const narrowBook = new ExcelJS.Workbook();
    await narrowBook.xlsx.load(workbookBuffer(await createReferencePackWorkbook(narrow, keyMap(narrow), "roundtrip")));
    const rows = narrowBook.getWorksheet("Entity Prerequisites")!;
    expect(rows.getRow(2).getCell(2).text).toBe("");
  });

  it("provides external tools with explicit add-only and full-record update rules", () => {
    const guide = createReferencePackGuide("Outcome: Complete diploma");
    expect(guide).toContain("Rows omitted from an import remain unchanged");
    expect(guide).toContain("Updates are not patches");
    expect(guide).toContain("optimistic <= expected <= pessimistic");
    expect(guide).toContain("unexpected **update**");
    expect(guide).toContain("# OpenRhen add-only pack instructions for external tools");
    expect(guide).toContain("Leave unused normal sheets with their header row only.");
    expect(guide).not.toContain("editing pack");
  });

  it("tells an editing pack's guide the opposite, rather than contradicting the workbook it came with", () => {
    const guide = createReferencePackGuide("Outcome: Complete diploma", "roundtrip");
    expect(guide).toContain("# OpenRhen editing pack instructions for external tools");
    expect(guide).toContain("This is an editing pack, not an add-only pack");
    expect(guide).not.toContain("do not reuse existing keys");
    expect(guide).toContain("arrive pre-filled with every current record in scope");
    expect(guide).toContain("unexpected **create**");
    expect(guide).toContain("Delete whole columns you were not asked to change");
    expect(guide).toContain("optimistic <= expected <= pessimistic");
  });

  it("keeps the safety rules numbered continuously, including the editing pack's extra one", () => {
    expect(createReferencePackGuide()).toContain("11. Confirmation is atomic");
    expect(createReferencePackGuide("Selected scope", "roundtrip")).toContain("12. Confirmation is atomic");
  });

  it("gives every column a format line, booleans included, not only enums and helped columns", () => {
    const guide = createReferencePackGuide();
    for (const spec of Object.values(importSpecs))
      for (const column of spec.columns) expect(guide).toContain(`- ${column.header}: `);
    expect(guide).toContain("- splittable: true or false");
  });

  it("states the limits and the offset rule an unattended tool would otherwise breach", () => {
    const guide = createReferencePackGuide();
    expect(guide).toContain("at most 2,000 rows across all sheets and 5 MB");
    expect(guide).toContain("without an offset is read in the importing user's own timezone");
    expect(guide).toContain("must not fall before start_date");
  });

  it("points the tool at the Instructions sheet, and warns the editing pack about guessed cells", () => {
    const add = createReferencePackGuide();
    const editing = createReferencePackGuide("Selected scope", "roundtrip");
    for (const guide of [add, editing]) expect(guide).toContain("`Instructions` sheet");
    expect(editing).toContain("## What is filled in from a guess, not from stored data");
    expect(editing).toContain("auto-classified from a flat legacy list");
    expect(editing).toContain("starts empty on every row");
    expect(add).not.toContain("filled in from a guess");
  });

  it("points each workbook at the guide filename that actually downloads beside it", async () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const selection = selectReferencePack(state, [{ type: "all" }]);
    const keys = keyMap(selection);
    for (const mode of ["add", "roundtrip"] as const) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(await createReferencePackWorkbook(selection, keys, mode)));
      expect(workbook.getWorksheet("Instructions")!.getColumn(2).values.join(" ")).toContain(
        referencePackGuideFilename(selection.slug, mode)
      );
    }
    expect(referencePackGuideFilename("plan", "add")).toBe("openrhen-reference-plan-tool-guide.md");
    expect(referencePackGuideFilename("plan", "roundtrip")).toBe("openrhen-roundtrip-plan-tool-guide.md");
    expect(referencePackWorkbookFilename("plan", "add")).toBe("openrhen-reference-plan.xlsx");
    expect(referencePackWorkbookFilename("plan", "roundtrip")).toBe("openrhen-roundtrip-plan.xlsx");
  }, 30_000); // Builds two full workbooks; the default 5 s timed out when the suite ran under load.

  it("reads the pack mode from the query, treating anything but roundtrip as add-only", () => {
    expect(parseReferencePackMode(new URLSearchParams("mode=roundtrip"))).toBe("roundtrip");
    expect(parseReferencePackMode(new URLSearchParams("mode=RoundTrip"))).toBe("add");
    expect(parseReferencePackMode(new URLSearchParams(""))).toBe("add");
  });

  it("lists every importable sheet's fields, required marks and allowed values from the import spec", () => {
    const guide = createReferencePackGuide();
    for (const spec of Object.values(importSpecs)) {
      expect(guide).toContain(`### ${spec.sheetName}`);
      for (const column of spec.columns) {
        expect(guide).toContain(`\`${column.header}${column.required ? "*" : ""}\``);
        if (column.kind === "enum") expect(guide).toContain(`- ${column.header}: ${column.enum!.join(", ")}`);
      }
    }
    expect(guide).toContain("### Recurring Commitments");
    expect(guide).toContain("`Recurring Commitments`");
    expect(guide).toContain("- status: needs_breakdown, cancelled, archived");
    expect(guide).not.toContain("recurrence rules are not supported");
  });

  it("combines mixed scopes, removes duplicate rows, and keeps time data explicit", () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const area = state.areas[0]!;
    const project = state.projects.find(
      (item) => state.outcomes.find((outcome) => outcome.id === item.outcomeId)?.areaId === area.id
    )!;
    const commitment = state.commitments[0]!;
    const selection = selectReferencePack(state, [
      { type: "area", id: area.id },
      { type: "project", id: project.id },
      { type: "fixed_commitment", id: commitment.id },
      { type: "area", id: area.id }
    ]);

    expect(selection.scopeLabel).toBe("2 selected scopes");
    expect(new Set(selection.projects.map((item) => item.id)).size).toBe(selection.projects.length);
    expect(selection.commitments.map((item) => item.id)).toEqual([commitment.id]);
  });

  it("separates the plan and the commitments folder", () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const plan = selectReferencePack(state, [{ type: "plan" }]);
    const time = selectReferencePack(state, [{ type: "fixed_commitments" }]);

    expect(plan.areas).toHaveLength(state.areas.length);
    expect(plan.commitments).toEqual([]);
    expect(time.areas).toEqual([]);
    expect(time.commitments).toHaveLength(state.commitments.length);
  });

  it("includes action prerequisites and every required ancestor", () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    const action = state.actions.find((item) => item.dependencyIds.length) ?? state.actions[0]!;
    const selection = selectReferencePack(state, [{ type: "action", id: action.id }]);

    expect(selection.actions.map((item) => item.id)).toEqual(
      expect.arrayContaining([action.id, ...action.dependencyIds])
    );
    expect(selection.projects.some((item) => item.id === action.projectId)).toBe(true);
    expect(selection.outcomes).not.toHaveLength(0);
    expect(selection.areas).not.toHaveLength(0);
  });

  it("parses repeated scopes and retains legacy single-scope links", () => {
    expect(parseReferencePackScopes(new URLSearchParams("scope=area:a&scope=project:p&scope=area:a"))).toEqual([
      { type: "area", id: "a" },
      { type: "project", id: "p" }
    ]);
    expect(parseReferencePackScopes(new URLSearchParams("scopeType=outcome&scopeId=o"))).toEqual([
      { type: "outcome", id: "o" }
    ]);
    expect(parseReferencePackScopes(new URLSearchParams())).toEqual([{ type: "all" }]);
  });

  it("rejects empty, malformed, and missing-record selections", () => {
    const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
    expect(() => selectReferencePack(state, [])).toThrow("Choose at least one");
    expect(() => parseReferencePackScopes(new URLSearchParams("scope=area:"))).toThrow("Choose a record");
    expect(() => parseReferencePackScopes(new URLSearchParams("scope=unknown:value"))).toThrow("Unsupported");
    expect(() => selectReferencePack(state, [{ type: "project", id: "missing" }])).toThrow(
      "selected project no longer exists"
    );
  });

  describe("round-trip mode", () => {
    it("pre-fills addition sheets with current data so every row previews as update", async () => {
      // A row untouched by dataValidation formulae would report rowCount accurately, but the addition
      // sheet's per-cell dropdown validation extends down to row 2001 regardless of real data, so
      // rowCount is not a reliable signal here — check the actual rows instead.
      const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
      const selection = selectReferencePack(state, [{ type: "all" }]);
      const keys = keyMap(selection);
      const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(bytes));
      const sheet = workbook.getWorksheet("Actions")!;
      const headers = (sheet.getRow(1).values as unknown[]).map((value) => String(value ?? ""));

      expect(sheet.getRow(2).getCell(headers.indexOf("import_key")).text).toBe(keys.action![state.actions[0]!.id]);
      expect(sheet.getRow(3).getCell(headers.indexOf("import_key")).text).toBe(keys.action![state.actions[1]!.id]);
      expect(sheet.getRow(state.actions.length + 2).getCell(headers.indexOf("import_key")).text).toBe("");
    });

    it("auto-fills requirements from an action's legacy contexts as a single required route", async () => {
      const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
      const action = state.actions[0]!;
      const selection = selectReferencePack(state, [{ type: "all" }]);
      const keys = keyMap(selection);
      const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(bytes));
      const headers = (workbook.getWorksheet("Actions")!.getRow(1).values as unknown[]).map((value) =>
        String(value ?? "")
      );
      const row = workbook.getWorksheet("Actions")!.getRow(2);

      expect(row.getCell(headers.indexOf("import_key")).text).toBe(keys.action![action.id]);
      expect(row.getCell(headers.indexOf("requirements")).text).toBe(action.contexts.join("+"));
      expect(row.getCell(headers.indexOf("prefers")).text).toBe("");
    });

    it("prefers real requirementPathways over the legacy-contexts guess once an action has been migrated", async () => {
      const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
      const migrated = {
        ...state.actions[0]!,
        contexts: ["home"],
        requirementPathways: [
          { id: "p1", contextIds: ["desktop"] },
          { id: "p2", contextIds: ["college"] }
        ]
      };
      state.actions = [migrated, ...state.actions.slice(1)];
      const selection = selectReferencePack(state, [{ type: "all" }]);
      const keys = keyMap(selection);
      const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(bytes));
      const headers = (workbook.getWorksheet("Actions")!.getRow(1).values as unknown[]).map((value) =>
        String(value ?? "")
      );

      expect(workbook.getWorksheet("Actions")!.getRow(2).getCell(headers.indexOf("requirements")).text).toBe(
        "desktop | college"
      );
    });

    it("exports real condition_definitions to the Conditions sheet (the flat catalogue it used to fall back to is retired)", async () => {
      const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
      state.conditionDefinitions = [
        {
          id: "home",
          name: "Home",
          kind: "location",
          status: "active",
          pathways: [],
          portability: "fixed",
          grants: ["desktop"],
          channels: [],
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ];
      const selection = selectReferencePack(state, [{ type: "all" }]);
      const keys = keyMap(selection);
      const bytes = await createReferencePackWorkbook(selection, keys, "roundtrip");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(bytes));
      const sheet = workbook.getWorksheet("Conditions")!;
      const headers = (sheet.getRow(1).values as unknown[]).map((value) => String(value ?? ""));

      expect(sheet.getRow(2).getCell(headers.indexOf("import_key")).text).toBe("home");
      expect(sheet.getRow(2).getCell(headers.indexOf("grants")).text).toBe("desktop");
      expect(sheet.getRow(3).getCell(headers.indexOf("import_key")).text).toBe("");
    });

    it("leaves the Conditions sheet empty in default add-only mode", async () => {
      const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));
      const selection = selectReferencePack(state, [{ type: "all" }]);
      const keys = keyMap(selection);
      const bytes = await createReferencePackWorkbook(selection, keys);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(workbookBuffer(bytes));

      expect(workbook.getWorksheet("Conditions")!.getRow(2).getCell(1).text).toBe("");
    });
  });
});

/**
 * exceljs declares its loader parameter as `Buffer extends ArrayBuffer`, so it wants a real
 * ArrayBuffer rather than a Node Buffer view. This is the same handoff the production reader does
 * (see `parseImportWorkbook` in import-xlsx.ts).
 */
function workbookBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function keyMap(selection: ReturnType<typeof selectReferencePack>): ReferenceKeyMap {
  const result: ReferenceKeyMap = {};
  for (const candidate of referenceKeyCandidates(selection)) {
    result[candidate.entityType] ??= {};
    result[candidate.entityType]![candidate.entityId] = fallbackReferenceKey(candidate);
  }
  return result;
}
