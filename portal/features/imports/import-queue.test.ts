import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportBatch } from "@openrhen/contracts";
import {
  describeImportBatchSource,
  describeImportBatchState,
  describeReopenedBatch,
  reconcileImportHistory,
  reconcileImportQueue,
  removeFromImportQueue,
  sortImportQueue,
  summarizeImportBatch,
  type ImportBatchSummary
} from "./import-queue";

const summary = (overrides: Partial<ImportBatchSummary> = {}): ImportBatchSummary => ({
  id: "b1",
  sourceType: "ai_text",
  inputKind: "brain_dump",
  status: "ready",
  version: 1,
  committedAt: null,
  createdAt: "2026-08-18T01:00:00.000Z",
  updatedAt: "2026-08-18T01:00:00.000Z",
  filename: null,
  recordCount: 3,
  blockingCount: 0,
  ...overrides
});

const record = (overrides: Partial<ImportBatch["records"][number]> = {}): ImportBatch["records"][number] => ({
  id: "r1",
  importKey: "k1",
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
});

const batch = (overrides: Partial<ImportBatch> = {}): ImportBatch => ({
  id: "b9",
  sourceType: "xlsx",
  inputKind: "planning_data",
  timezone: "Australia/Sydney",
  templateVersion: "1",
  status: "blocked",
  version: 2,
  records: [
    record(),
    record({ id: "r2", importKey: "k2", errors: ["Missing title"] }),
    record({ id: "r3", importKey: "k3", removed: true, errors: ["ignored because removed"] }),
    record({ id: "r4", importKey: "k4", operation: "conflict" })
  ],
  source: { filename: "plan.xlsx" },
  createdAt: "2026-08-19T03:00:00.000Z",
  ...overrides
});

describe("describeImportBatchSource", () => {
  it("labels a source id it has no wording for with its registry label", () => {
    expect(describeImportBatchSource(summary({ sourceType: "some_new_source", inputKind: "calendar_updates" }))).toBe(
      "Some New Source · calendar updates"
    );
  });

  it("names a workbook by its file and an AI, Example Shared or Example Daily batch by what it was read as", () => {
    expect(describeImportBatchSource(summary({ sourceType: "xlsx", filename: "plan.xlsx" }))).toBe(
      "Workbook · plan.xlsx"
    );
    expect(describeImportBatchSource(summary({ sourceType: "csv", filename: null }))).toBe("CSV · brain dump");
    expect(describeImportBatchSource(summary({ sourceType: "ai_image", inputKind: "assignment" }))).toBe(
      "AI · assignment"
    );
    expect(describeImportBatchSource(summary({ sourceType: "example_shared", inputKind: "calendar_updates" }))).toBe(
      "Example Shared · calendar updates"
    );
    expect(describeImportBatchSource(summary({ sourceType: "example_daily", inputKind: "calendar_updates" }))).toBe(
      "Example Daily · calendar updates"
    );
    expect(describeImportBatchSource(summary({ sourceType: "google_calendar", inputKind: "calendar_updates" }))).toBe(
      "Google Calendar · calendar updates"
    );
  });
});

describe("describeImportBatchState", () => {
  it("says whether the batch can go, with counts in the right number", () => {
    expect(describeImportBatchState(summary({ recordCount: 1, blockingCount: 0 }))).toBe("1 record · ready to commit");
    expect(describeImportBatchState(summary({ recordCount: 5, blockingCount: 1 }))).toBe("5 records · 1 blocker");
    expect(describeImportBatchState(summary({ recordCount: 5, blockingCount: 2 }))).toBe("5 records · 2 blockers");
    expect(describeImportBatchState(summary({ status: "committed" }))).toBe("3 records · committed");
  });
});

describe("summarizeImportBatch", () => {
  it("counts only records that would be committed, and blockers the way the review does", () => {
    const result = summarizeImportBatch(batch());
    expect(result).toMatchObject({
      id: "b9",
      sourceType: "xlsx",
      status: "blocked",
      version: 2,
      filename: "plan.xlsx",
      recordCount: 3,
      blockingCount: 2,
      createdAt: "2026-08-19T03:00:00.000Z"
    });
  });
});

describe("sortImportQueue and reconcileImportQueue", () => {
  it("keeps the newest preview first", () => {
    const sorted = sortImportQueue([
      summary({ id: "old", createdAt: "2026-08-01T00:00:00.000Z" }),
      summary({ id: "new", createdAt: "2026-08-19T00:00:00.000Z" })
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("inserts a fresh preview, refreshes a saved one, and drops a committed one", () => {
    const start = [summary({ id: "b1" })];
    const withNew = reconcileImportQueue(start, batch());
    expect(withNew.map((item) => item.id)).toEqual(["b9", "b1"]);
    const saved = reconcileImportQueue(withNew, batch({ status: "ready", version: 3, records: [record()] }));
    expect(saved.find((item) => item.id === "b9")).toMatchObject({ status: "ready", version: 3, blockingCount: 0 });
    expect(saved).toHaveLength(2);
    const committed = reconcileImportQueue(saved, batch({ status: "committed" }));
    expect(committed.map((item) => item.id)).toEqual(["b1"]);
  });
});

describe("removeFromImportQueue", () => {
  it("drops the deleted batch and leaves every other one, including on an id that is not there", () => {
    const start = [summary({ id: "b1" }), summary({ id: "b2" })];
    expect(removeFromImportQueue(start, "b1").map((item) => item.id)).toEqual(["b2"]);
    expect(removeFromImportQueue(start, "gone")).toEqual(start);
  });
});

describe("describeReopenedBatch", () => {
  it("names when the batch was first previewed, in the batch's own timezone", () => {
    expect(describeReopenedBatch({ createdAt: "2026-08-18T01:05:00.000Z", timezone: "Australia/Sydney" })).toBe(
      "This file was already previewed on 18 Aug 2026, 11:05 am; reopened that batch instead of adding another."
    );
  });

  it("still explains itself when the batch carries no creation time", () => {
    expect(describeReopenedBatch({ timezone: "Australia/Sydney" })).toBe(
      "This file was already previewed on an earlier visit; reopened that batch instead of adding another."
    );
  });
});

describe("import history", () => {
  const committed = (id: string) =>
    ({ ...batch(), id, status: "committed" }) as Parameters<typeof reconcileImportHistory>[1];

  it("takes a committed batch out of the queue and into history in one move", () => {
    const queue = [summary({ id: "open" }), summary({ id: "done" })];
    const batchDone = committed("done");
    expect(reconcileImportQueue(queue, batchDone).map((item) => item.id)).toEqual(["open"]);
    expect(reconcileImportHistory([], batchDone).map((item) => item.id)).toEqual(["done"]);
  });

  it("ignores a batch that has not been committed, so history only ever grows by a real import", () => {
    expect(reconcileImportHistory([], batch())).toEqual([]);
  });

  it("puts the newest import first and never lists one twice", () => {
    const first = reconcileImportHistory([], committed("a"));
    const second = reconcileImportHistory(first, committed("b"));
    expect(second.map((item) => item.id)).toEqual(["b", "a"]);
    expect(reconcileImportHistory(second, committed("a")).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("stamps a commit time on a batch summarised as committed, and none on an open one", () => {
    expect(summarizeImportBatch(committed("a")).committedAt).not.toBeNull();
    expect(summarizeImportBatch(batch()).committedAt).toBeNull();
  });
});
