import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { keepWholeMovePairs, tagMoveRecord } from "./calendar-feed-moves";

const EVENT = "calendar_feed:event:";
const rec = (importKey: string, operation: ImportRecord["operation"], relationships: Record<string, string> = {}) =>
  ({ id: importKey + operation, importKey, operation, relationships }) as unknown as ImportRecord;
const half = (importKey: string, operation: ImportRecord["operation"]) =>
  rec(importKey, operation, { feedSeries: "w", feedMove: "mv:w:2026-11-10", feedMoveSize: "2" });

describe("keepWholeMovePairs", () => {
  it("keeps both halves, and records outside any pair", () => {
    const out = keepWholeMovePairs(
      [
        half("calendar_feed:occ:r:2026-11-10", "update"),
        half(`${EVENT}w#move20261110`, "create"),
        rec(`${EVENT}x`, "update")
      ],
      EVENT
    );
    expect(out).toHaveLength(3);
  });

  it("drops a date's cancel whose replacement is not in the batch, so the original is never cancelled alone", () => {
    expect(keepWholeMovePairs([half("calendar_feed:occ:r:2026-11-10", "update")], EVENT)).toEqual([]);
  });

  it("drops a replacement's delete whose date record is not in the batch", () => {
    expect(keepWholeMovePairs([half(`${EVENT}w#move20261110`, "delete")], EVENT)).toEqual([]);
  });

  it("keeps a replacement's create alone as an ordinary create, without the pair", () => {
    const [out] = keepWholeMovePairs([half(`${EVENT}w#move20261110`, "create")], EVENT);
    expect(out!.relationships).toEqual({ feedSeries: "w" });
  });
});

describe("tagMoveRecord", () => {
  const known = new Map([["w#move20261110", "2026-11-10"]]);
  it("pairs a create or delete, but not a change to a replacement already on the plan", () => {
    expect(tagMoveRecord(rec(`${EVENT}w#move20261110`, "create"), known, EVENT).relationships).toMatchObject({
      feedMove: "mv:w:2026-11-10",
      feedMoveSize: "2",
      feedMoveOf: "2026-11-10"
    });
    const update = tagMoveRecord(rec(`${EVENT}w#move20261110`, "update"), known, EVENT);
    expect(update.relationships.feedMove).toBeUndefined();
    expect(update.relationships).toMatchObject({ feedSeries: "w", feedMoveOf: "2026-11-10" });
  });
  it("leaves any other event alone", () => {
    const other = rec(`${EVENT}w#20261110`, "create");
    expect(tagMoveRecord(other, known, EVENT)).toBe(other);
  });
});
