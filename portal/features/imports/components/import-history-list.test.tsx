// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import type { ImportBatchSummary } from "@/features/imports/import-queue";
import { ImportHistoryList } from "./import-history-list";

const entry = (overrides: Partial<ImportBatchSummary> = {}): ImportBatchSummary => ({
  id: "b1",
  sourceType: "xlsx",
  inputKind: "planning_data",
  status: "committed",
  version: 2,
  committedAt: "2026-08-23T02:13:46.000Z",
  createdAt: "2026-08-23T02:12:58.000Z",
  updatedAt: "2026-08-23T02:13:46.000Z",
  filename: "college-units.xlsx",
  recordCount: 22,
  blockingCount: 0,
  ...overrides
});

const props = { selectedId: null, busy: false, onOpen: vi.fn(), now: Date.parse("2026-08-25T00:00:00.000Z") };

describe("ImportHistoryList", () => {
  it("stays folded and says so when nothing was committed in the last 7 days", () => {
    const { container } = render(
      <ImportHistoryList {...props} history={[entry({ committedAt: "2026-08-10T00:00:00.000Z" })]} />
    );
    const fold = container.querySelector<HTMLDetailsElement>("details.inbox-history")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toContain("Recently handled");
    expect(fold.querySelector("summary")!.textContent).toContain("0");
    expect(screen.getByText("No import was committed in the last 7 days.")).toBeTruthy();
    expect(screen.queryByText("Workbook · college-units.xlsx")).toBeNull();
  });

  it("folds away closed, counting what it holds", () => {
    const { container } = render(<ImportHistoryList {...props} history={[entry(), entry({ id: "b2" })]} />);
    const fold = container.querySelector<HTMLDetailsElement>("details.inbox-history")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toContain("2");
  });

  it("names each import and when it was written, not when it was previewed", () => {
    render(<ImportHistoryList {...props} history={[entry()]} />);
    expect(screen.getByText("Workbook · college-units.xlsx")).toBeTruthy();
    expect(screen.getByText(/22 records · imported/)).toBeTruthy();
  });

  it("falls back to the last update when a commit time never reached the client", () => {
    render(<ImportHistoryList {...props} history={[entry({ committedAt: null })]} />);
    expect(screen.getByText(/22 records · imported/)).toBeTruthy();
  });

  /** A committed batch cannot be edited, re-committed or deleted, so the row offers none of it. */
  it("offers no delete, unlike the queue above it", () => {
    render(<ImportHistoryList {...props} history={[entry()]} />);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("opens a row for reading", () => {
    const onOpen = vi.fn();
    render(<ImportHistoryList {...props} history={[entry()]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /college-units.xlsx/ }));
    expect(onOpen).toHaveBeenCalledWith("b1");
  });
});
