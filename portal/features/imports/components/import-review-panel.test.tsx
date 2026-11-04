// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen, within } from "@/test/render";
import { IMPORT_VIEW_STORAGE_KEY } from "@/features/imports/import-table";
import { ImportReviewPanel } from "./import-review-panel";
import type { PortalState } from "@/state/portal-state";

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "action:one",
    entityType: "action",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {},
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

/** Two blank fields whose columns carry a default, so the bulk offer has something to fill. */
const missingStatusAndEnergy: ImportRecord["fields"] = {
  status: { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true, source: "cell" },
  energy: { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true, source: "cell" }
};

const recordActions = {
  conditionCatalog: ["home"],
  places: [] as unknown as PortalState["conditionDefinitions"],
  routinePresets: [] as unknown as PortalState["routinePresets"],
  timeBands: [],
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

const props = {
  records: [record(), record({ id: "record-2", operation: "update" as const })],
  visibleRecords: [record()],
  sourceType: "ai_text" as const,
  filter: "all" as const,
  blocking: 0,
  ready: 2,
  pendingEdits: false,
  calendarCount: 0,
  selectedCalendarCount: 0,
  onFilterChange: vi.fn(),
  onCalendarSelection: vi.fn(),
  onApplyDefaults: vi.fn(),
  onRemoveBlockers: vi.fn(),
  recordActions
};

/** A batch of rows read from a file, which is the only kind that can be read as a table. */
const workbook = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    record({ id: `row-${index}`, importKey: `action:${index}`, fields: { title: explicitTitle(index) } })
  );
const explicitTitle = (index: number): ImportRecord["fields"][string] => ({
  value: `Row ${index}`,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false,
  source: "cell"
});

let wide = true;
beforeEach(() => {
  wide = true;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia = ((query: string) =>
    ({
      matches: wide,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

describe("ImportReviewPanel", () => {
  it("stops counting a removed record in the batch line, and says how many were removed", () => {
    const records = [record(), record({ id: "record-2", removed: true }), record({ id: "record-3" })];
    const { container } = render(<ImportReviewPanel {...props} records={records} blocking={1} />);
    expect(container.querySelector(".section-heading span")!.textContent).toBe("2 records · 1 removed · 1 blocker");
  });

  it("counts the whole batch rather than the filtered view", () => {
    const { container } = render(<ImportReviewPanel {...props} filter="ready" blocking={2} />);
    expect(container.querySelector(".section-heading span")!.textContent).toBe("2 records · 2 blockers");
    expect([...container.querySelectorAll(".import-summary span small")].map((item) => item.textContent)).toEqual([
      "creates",
      "updates",
      "links",
      "warnings",
      "blockers"
    ]);
    expect(container.querySelector(".import-summary span")!.textContent).toBe("1creates");
  });

  it("marks the active filter and reports a change", () => {
    const onFilterChange = vi.fn();
    render(<ImportReviewPanel {...props} filter="warnings" onFilterChange={onFilterChange} />);
    expect(screen.getByRole("button", { name: "warnings" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "ready" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "rejected" }));
    expect(onFilterChange).toHaveBeenCalledWith("rejected");
  });

  it("hides the calendar toolbar when the batch has no events", () => {
    const { container } = render(<ImportReviewPanel {...props} />);
    expect(container.querySelector(".calendar-selection-toolbar")).toBeNull();
  });

  it("selects and clears every event from the calendar toolbar", () => {
    const onCalendarSelection = vi.fn();
    render(
      <ImportReviewPanel
        {...props}
        calendarCount={3}
        selectedCalendarCount={1}
        onCalendarSelection={onCalendarSelection}
      />
    );
    expect(screen.getByText("1 of 3 events selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(onCalendarSelection).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onCalendarSelection).toHaveBeenLastCalledWith(false);
  });

  it("says so when the filter matches nothing", () => {
    render(<ImportReviewPanel {...props} visibleRecords={[]} />);
    expect(screen.getByText("No records match this filter.")).toBeTruthy();
  });

  it("keeps the counts and the commit gate apart once the batch has been edited here", () => {
    render(<ImportReviewPanel {...props} pendingEdits ready={7} />);
    expect(screen.getByRole("status").textContent).toBe("7 ready after your edits · save the draft to confirm");
  });

  it("says nothing about unsaved edits before any have been made", () => {
    const { container } = render(<ImportReviewPanel {...props} />);
    expect(container.querySelector(".save-notice")).toBeNull();
  });

  it("shows whatever the page wants said about this batch beside the batch", () => {
    render(<ImportReviewPanel {...props} banners={<p className="form-error">Commit failed.</p>} />);
    expect(screen.getByText("Commit failed.")).toBeTruthy();
  });

  it("offers the blank fields in view to be defaulted at once, counting them", () => {
    const onApplyDefaults = vi.fn();
    // status and energy both carry a column default; only the visible record is counted.
    const blank = record({ id: "blank", entityType: "action", fields: missingStatusAndEnergy });
    render(<ImportReviewPanel {...props} visibleRecords={[blank]} onApplyDefaults={onApplyDefaults} />);
    const button = screen.getByRole("button", { name: "Apply defaults to 2 blank fields" });
    fireEvent.click(button);
    expect(onApplyDefaults).toHaveBeenCalledOnce();
  });

  it("disables both bulk actions when neither would do anything", () => {
    render(<ImportReviewPanel {...props} />);
    expect(
      (screen.getByRole("button", { name: "Apply defaults to all blank fields" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Remove all blockers" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before dropping the rows that still have errors, and says how many", () => {
    const onRemoveBlockers = vi.fn();
    const blocked = record({ id: "blocked", errors: ["status is required."] });
    const { container } = render(
      <ImportReviewPanel {...props} visibleRecords={[blocked]} onRemoveBlockers={onRemoveBlockers} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 blockers" }));
    const confirmation = within(container.querySelector<HTMLElement>(".bulk-confirm")!);
    expect(confirmation.getByText(/Remove 1 record that still has errors\?/)).toBeTruthy();
    expect(onRemoveBlockers).not.toHaveBeenCalled();
    fireEvent.click(confirmation.getByRole("button", { name: "Remove" }));
    expect(onRemoveBlockers).toHaveBeenCalledOnce();
  });

  it("lets the confirmation be waved away without removing anything", () => {
    const onRemoveBlockers = vi.fn();
    const blocked = record({ id: "blocked", errors: ["status is required."] });
    render(<ImportReviewPanel {...props} visibleRecords={[blocked]} onRemoveBlockers={onRemoveBlockers} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 blockers" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(onRemoveBlockers).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove 1 blockers" })).toBeTruthy();
  });

  it("offers no table for a source whose provenance the cards carry", () => {
    const rows = workbook(30);
    const { container } = render(<ImportReviewPanel {...props} records={rows} visibleRecords={rows} />);
    expect(screen.queryByRole("group", { name: "Review layout" })).toBeNull();
    expect(container.querySelector(".import-table")).toBeNull();
  });

  it("opens a workbook of many rows as a table and a short one as cards", () => {
    const many = workbook(30);
    const { container, unmount } = render(
      <ImportReviewPanel {...props} sourceType="xlsx" records={many} visibleRecords={many} />
    );
    expect(container.querySelector(".import-table")).toBeTruthy();
    unmount();
    const few = workbook(3);
    const short = render(<ImportReviewPanel {...props} sourceType="csv" records={few} visibleRecords={few} />);
    expect(short.container.querySelector(".import-table")).toBeNull();
    expect(short.container.querySelectorAll(".import-record")).toHaveLength(3);
  });

  it("falls back to cards on a phone, and does not offer the choice there", () => {
    wide = false;
    const rows = workbook(30);
    const { container } = render(
      <ImportReviewPanel {...props} sourceType="xlsx" records={rows} visibleRecords={rows} />
    );
    expect(container.querySelector(".import-table")).toBeNull();
    expect(screen.queryByRole("group", { name: "Review layout" })).toBeNull();
  });

  it("remembers the chosen layout across batches", () => {
    const rows = workbook(30);
    const { container, unmount } = render(
      <ImportReviewPanel {...props} sourceType="xlsx" records={rows} visibleRecords={rows} />
    );
    fireEvent.click(within(container.querySelector<HTMLElement>(".import-view-toggle")!).getByText("Cards"));
    expect(container.querySelector(".import-table")).toBeNull();
    expect(screen.getByRole("button", { name: "Cards" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(IMPORT_VIEW_STORAGE_KEY)).toBe("cards");
    unmount();
    const again = render(<ImportReviewPanel {...props} sourceType="xlsx" records={rows} visibleRecords={rows} />);
    expect(again.container.querySelector(".import-table")).toBeNull();
  });

  it("narrows the bulk actions to what the table's search leaves on screen", () => {
    window.localStorage.setItem(IMPORT_VIEW_STORAGE_KEY, "table");
    const onRemoveBlockers = vi.fn();
    const rows = [
      record({ id: "one", importKey: "action:one", errors: ["title is required."] }),
      record({ id: "two", importKey: "action:two", errors: ["title is required."] })
    ];
    const { container } = render(
      <ImportReviewPanel
        {...props}
        sourceType="xlsx"
        records={rows}
        visibleRecords={rows}
        onRemoveBlockers={onRemoveBlockers}
      />
    );
    expect(screen.getByRole("button", { name: "Remove 2 blockers" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "action:two" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 blockers" }));
    fireEvent.click(
      within(container.querySelector<HTMLElement>(".bulk-confirm")!).getByRole("button", {
        name: "Remove"
      })
    );
    expect(onRemoveBlockers).toHaveBeenCalledWith([expect.objectContaining({ id: "two" })]);
  });

  it("takes a table row to its card when the card is asked for", () => {
    const rows = workbook(30);
    const { container } = render(
      <ImportReviewPanel {...props} sourceType="xlsx" records={rows} visibleRecords={rows} />
    );
    fireEvent.click(container.querySelectorAll<HTMLElement>(".import-table-actions button")[0]!);
    expect(container.querySelector(".import-table")).toBeNull();
    expect(container.querySelector("#import-record-row-0")).toBeTruthy();
  });
});
