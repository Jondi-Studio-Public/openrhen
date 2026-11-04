// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen, within } from "@/test/render";
import { buildImportTableGroups, type ImportTableSort } from "@/features/imports/import-table";
import { SOURCE_ROW, SOURCE_SHEET } from "@/features/imports/import-record-source";
import { ImportTable } from "./import-table";
import type { PortalState } from "@/state/portal-state";

const explicit = (value: unknown): ImportField => ({
  value,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false,
  source: "cell"
});

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "action:one",
    entityType: "action",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: { title: explicit("Draft section one"), status: explicit("active") },
    relationships: { projectKey: "project:thesis", [SOURCE_SHEET]: "Actions", [SOURCE_ROW]: "14" },
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

function actions() {
  return {
    conditionCatalog: ["home", "laptop"],
    places: [] as unknown as PortalState["conditionDefinitions"],
    routinePresets: [] as unknown as PortalState["routinePresets"],
    timeBands: [],
    batchKeys: { project: ["project:thesis", "project:other"] },
    updateField: vi.fn(),
    applyLocation: vi.fn(),
    createCustomLocation: vi.fn(),
    selectRoutine: vi.fn(),
    patchRoutineSteps: vi.fn(),
    updateRelationship: vi.fn(),
    resolveCalendarConflict: vi.fn(),
    applyDefault: vi.fn(),
    toggleRemoved: vi.fn(),
    acceptOverlap: vi.fn(),
    acceptCancel: vi.fn(),
    resolveSourceMatch: vi.fn(),
    dropCommitment: vi.fn()
  };
}

function draw(records: ImportRecord[], overrides: Partial<Parameters<typeof ImportTable>[0]> = {}) {
  const props = {
    groups: buildImportTableGroups(records, { sort: (overrides.sort ?? null) as ImportTableSort | null }),
    sort: null,
    query: "",
    onSortChange: vi.fn(),
    onQueryChange: vi.fn(),
    onOpenCard: vi.fn(),
    actions: actions(),
    ...overrides
  };
  return { ...render(<ImportTable {...props} />), props };
}

const cell = (container: HTMLElement, id: string, name: string) =>
  container.querySelector<HTMLElement>(`[data-cell="${id}--${name}"]`)!;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

describe("ImportTable", () => {
  it("draws one table per entity type, headed by the sheet, with the spec's columns in order", () => {
    const { container } = draw([record(), record({ id: "p1", entityType: "project", importKey: "project:thesis" })]);
    expect([...container.querySelectorAll("h3")].map((item) => item.textContent)).toEqual(["Projects", "Actions"]);
    const table = container.querySelectorAll("table")[1]!;
    const headers = [...table.querySelectorAll("thead th")].map((item) => item.textContent);
    expect(headers.slice(0, 5)).toEqual(["status", "row", "import_key", "project_key", "title"]);
    expect(headers.at(-1)).toBe("actions");
  });

  it("says where each row sat in the file and how it stands", () => {
    const { container } = draw([record({ errors: ["title is required."] })]);
    expect(container.querySelector(".import-row-status")!.textContent).toBe("blocked");
    expect(container.querySelector(".import-table-source")!.textContent).toBe("Row 14 · Actions");
  });

  it("shows every cell as text until a row is being edited, then only that row holds inputs", () => {
    const { container } = draw([record(), record({ id: "record-2", importKey: "action:two" })]);
    // Only the search box is a form control while nothing is being edited.
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(1);
    fireEvent.click(within(cell(container, "record-1", "title")).getByRole("button"));
    const editing = container.querySelector(".import-table-row.editing")!;
    expect(editing.querySelectorAll("input, select, textarea").length).toBeGreaterThan(1);
    expect(cell(container, "record-2", "title").querySelector("input")).toBeNull();
  });

  it("reports a cell edit as the field it belongs to", () => {
    const { container, props } = draw([record()]);
    fireEvent.click(within(cell(container, "record-1", "title")).getByRole("button"));
    fireEvent.change(within(cell(container, "record-1", "title")).getByRole("textbox"), {
      target: { value: "Renamed" }
    });
    expect(props.actions.updateField).toHaveBeenCalledWith("record-1", "title", "Renamed");
  });

  it("edits an enum cell through the choices its spec allows", () => {
    const { container, props } = draw([record()]);
    fireEvent.click(within(cell(container, "record-1", "status")).getByRole("button"));
    const select = within(cell(container, "record-1", "status")).getByRole("combobox");
    expect([...select.querySelectorAll("option")].map((item) => item.textContent)).toContain("waiting");
    fireEvent.change(select, { target: { value: "waiting" } });
    expect(props.actions.updateField).toHaveBeenCalledWith("record-1", "status", "waiting");
  });

  it("edits a relationship key with the batch's own keys offered", () => {
    const { container, props } = draw([record()]);
    fireEvent.click(within(cell(container, "record-1", "projectKey")).getByRole("button"));
    // A text box with a datalist is a combobox, which is exactly what a key with suggestions is.
    const input = within(cell(container, "record-1", "projectKey")).getByRole("combobox", { name: "project_key" });
    fireEvent.change(input, { target: { value: "project:other" } });
    expect(props.actions.updateRelationship).toHaveBeenCalledWith("record-1", "projectKey", "project:other");
    expect(cell(container, "record-1", "projectKey").querySelectorAll("datalist option")).toHaveLength(2);
  });

  it("asks for a sort when a header is clicked", () => {
    const { props } = draw([record()]);
    fireEvent.click(screen.getAllByRole("button", { name: /^title/ })[0]!);
    expect(props.onSortChange).toHaveBeenCalledWith({ key: "title", direction: "asc" });
  });

  it("marks the sorted column for a reader who cannot see the arrow", () => {
    const { container } = draw([record()], { sort: { key: "title", direction: "desc" } });
    const header = [...container.querySelectorAll("thead th")].find((item) => item.textContent!.startsWith("title"))!;
    expect(header.getAttribute("aria-sort")).toBe("descending");
  });

  it("reports what is being searched for", () => {
    const { props } = draw([record()]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "draft" } });
    expect(props.onQueryChange).toHaveBeenCalledWith("draft");
  });

  it("outlines an offending cell and names the message in its tooltip", () => {
    const { container } = draw([record({ errors: ["title is required."] })]);
    const offending = cell(container, "record-1", "title");
    expect(offending.className).toContain("has-error");
    expect(offending.getAttribute("title")).toBe("title is required.");
    expect(offending.querySelector("button")!.getAttribute("aria-invalid")).toBe("true");
  });

  it("lists what is wrong under the row being edited, and only that row", () => {
    const { container } = draw([record({ errors: ["title is required."], warnings: ["Check the estimate."] })]);
    expect(container.querySelector(".import-table-messages")).toBeNull();
    fireEvent.click(within(cell(container, "record-1", "title")).getByRole("button"));
    const strip = container.querySelector(".import-table-messages")!;
    expect([...strip.querySelectorAll("span")].map((item) => item.textContent)).toEqual([
      "title is required.",
      "Check the estimate."
    ]);
  });

  it("reads a message the way the card does: plain field labels and local times", () => {
    const { container } = draw(
      [
        record({
          fields: { title: explicit("Shift"), endsAt: explicit("2026-09-04T10:00:00+10:00") },
          errors: ["endsAt must be after 2026-09-03T00:00:00.000Z."]
        })
      ],
      { actions: { ...actions(), timezone: "Australia/Sydney" } }
    );
    fireEvent.click(within(cell(container, "record-1", "title")).getByRole("button"));
    expect(container.querySelector(".import-table-messages")!.textContent).toMatch(
      /^Ends must be after Thu, 3 Sep\w* at 10:00 am\.$/
    );
  });

  it("steps to the next blocking cell and puts the caret in it", () => {
    const { container } = draw([
      record({ id: "clean", importKey: "action:clean" }),
      record({ id: "broken", importKey: "action:broken", fields: {}, errors: ["title is required."] })
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Next blocker" }));
    expect(cell(container, "broken", "title").contains(document.activeElement)).toBe(true);
  });

  it("walks the blockers with ] and [ when the caret is not in a text box", () => {
    const { container } = draw([
      record({ id: "one", importKey: "action:one", fields: {}, errors: ["title is required."] }),
      record({ id: "two", importKey: "action:two", fields: {}, errors: ["title is required."] })
    ]);
    const view = container.querySelector(".import-table-view")!;
    fireEvent.keyDown(view, { key: "]" });
    expect(cell(container, "one", "title").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(view, { key: "[" });
    expect(cell(container, "two", "title").contains(document.activeElement)).toBe(true);
  });

  it("leaves a bracket typed into a cell alone", () => {
    const { container } = draw([record({ id: "broken", fields: {}, errors: ["title is required."] })]);
    fireEvent.click(within(cell(container, "broken", "status")).getByRole("button"));
    const input = cell(container, "broken", "title").querySelector("input")!;
    fireEvent.keyDown(input, { key: "]" });
    expect(container.querySelectorAll(".import-table-row.editing")).toHaveLength(1);
    expect(cell(container, "broken", "title").contains(document.activeElement)).toBe(false);
  });

  it("says so when there is nothing left to jump to", () => {
    draw([record()]);
    expect((screen.getByRole("button", { name: "Next blocker" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No blockers")).toBeTruthy();
  });

  it("puts the blockers first and lands on the first one", () => {
    const { container, props } = draw([record({ id: "broken", fields: {}, errors: ["title is required."] })]);
    fireEvent.click(screen.getByRole("button", { name: "Blockers first" }));
    expect(props.onSortChange).toHaveBeenCalledWith({ key: "_status", direction: "asc" });
    expect(cell(container, "broken", "title").contains(document.activeElement)).toBe(true);
  });

  it("takes a row to its card, and removes or restores it in place", () => {
    const { props } = draw([record({ removed: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(props.onOpenCard).toHaveBeenCalledWith("record-1");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(props.actions.toggleRemoved).toHaveBeenCalledWith("record-1");
  });

  it("says so when the search matched nothing", () => {
    draw([], { query: "nothing" });
    expect(screen.getByText("No rows match this filter.")).toBeTruthy();
  });

  it("draws two hundred rows without two hundred rows of inputs", () => {
    const rows = Array.from({ length: 200 }, (_, index) =>
      record({ id: `record-${index}`, importKey: `action:${index}` })
    );
    const { container } = draw(rows);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(200);
    // 22 columns × 200 rows of live form controls is what the cards cost; the table costs one row's.
    expect(container.querySelectorAll("tbody input, tbody select, tbody textarea")).toHaveLength(0);
    fireEvent.click(within(cell(container, "record-7", "title")).getByRole("button"));
    const live = container.querySelectorAll("tbody input, tbody select, tbody textarea");
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThanOrEqual(container.querySelectorAll("thead th").length);
  });
});
