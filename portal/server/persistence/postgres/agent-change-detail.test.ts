import { describe, expect, it } from "vitest";
import {
  actionIdOf,
  buildRows,
  diffImages,
  fieldsFromEvidence,
  isNoiseColumn,
  isShownColumn,
  missingPlanReason,
  PENDING_WINDOW_MS,
  pickTitle,
  resolveIdFields,
  shareBasis
} from "./agent-change-detail";

describe("diffImages", () => {
  it("lists only the changed columns and hides noise", () => {
    const before = { id: "a", user_id: "u", title: "Old", version: 1, updated_at: "t1", status: "open", note: null };
    const after = { id: "a", user_id: "u", title: "New", version: 2, updated_at: "t2", status: "open", note: null };
    expect(diffImages(before, after)).toEqual([{ field: "title", before: "Old", after: "New", afterKnown: true }]);
  });
  it("compares json values by content", () => {
    expect(diffImages({ tags: ["a"] }, { tags: ["a"] })).toEqual([]);
    expect(diffImages({ tags: ["a"] }, { tags: ["a", "b"] })).toHaveLength(1);
  });
  it("shows a create as after only and a delete as before only", () => {
    expect(diffImages(null, { id: "a", title: "T", created_at: "x" })).toEqual([
      { field: "title", before: null, after: "T", afterKnown: true }
    ]);
    expect(diffImages({ id: "a", title: "T" }, null)).toEqual([
      { field: "title", before: "T", after: null, afterKnown: true }
    ]);
  });
  it("treats *_recorded_at as bookkeeping", () => {
    expect(isNoiseColumn("ends_at_recorded_at")).toBe(true);
    expect(isNoiseColumn("ends_at")).toBe(false);
  });
});

describe("fieldsFromEvidence", () => {
  it("keeps the before values with the after unknown", () => {
    expect(fieldsFromEvidence({ before: { title: "Old", version: 3 } })).toEqual([
      { field: "title", before: "Old", after: null, afterKnown: false }
    ]);
  });
  it("is empty when no before was recorded", () => {
    expect(fieldsFromEvidence({ before: null, beforeMissing: true })).toEqual([]);
    expect(fieldsFromEvidence({})).toEqual([]);
  });
});

describe("pickTitle and actionIdOf", () => {
  it("prefers title, then name, then label, after before before", () => {
    expect(pickTitle({ title: "B" }, { title: "A" })).toBe("A");
    expect(pickTitle({ name: "N" }, null)).toBe("N");
    expect(pickTitle(null, { label: "L" })).toBe("L");
    expect(pickTitle({ title: " " }, { note: "x" })).toBeNull();
  });
  it("reads the action a row hangs off", () => {
    expect(actionIdOf({ action_id: "a1" }, null)).toBe("a1");
    expect(actionIdOf(null, { action_id: 5 })).toBeNull();
  });
});

describe("buildRows", () => {
  const image = (id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) => ({
    table: "actions" as const,
    id,
    before,
    after
  });
  it("joins an image to its ledger row, carries basis and quote, and keeps unmatched images", () => {
    const rows = buildRows(
      [
        {
          entityType: "action",
          entityId: "a1",
          operation: "save",
          evidence: { basis: "stated", statedEvidence: "do it" }
        },
        { entityType: "planning", entityId: null, operation: "save", evidence: { before: { x: 1 } } }
      ],
      [
        image("a1", { id: "a1", title: "T", expected_minutes: 10 }, { id: "a1", title: "T", expected_minutes: 20 }),
        image("a2", null, { id: "a2", title: "New" })
      ]
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      entityType: "action",
      title: "T",
      basis: "stated",
      statedEvidence: "do it",
      fields: [{ field: "expected_minutes", before: 10, after: 20, afterKnown: true }]
    });
    expect(rows[1]!.fields).toEqual([{ field: "x", before: 1, after: null, afterKnown: false }]);
    expect(rows[2]).toMatchObject({ entityType: "actions", entityId: "a2", operation: "create", title: "New" });
  });
});

describe("isShownColumn", () => {
  it("shows exactly the allowlist for a known table", () => {
    expect(isShownColumn("projects", "title")).toBe(true);
    expect(isShownColumn("projects", "outcome_id")).toBe(true);
    for (const hidden of ["forecast_started_at", "baseline_estimate_minutes", "actual_completion_ratio", "version"])
      expect(isShownColumn("projects", hidden)).toBe(false);
    expect(isShownColumn("sessions", "recommendation_id")).toBe(false);
  });
  it("for an unknown table drops noise, *_id and engine names", () => {
    expect(isShownColumn("widgets", "label")).toBe(true);
    expect(isShownColumn("widgets", "owner_id")).toBe(false);
    expect(isShownColumn("widgets", "forecast_x")).toBe(false);
    expect(isShownColumn("widgets", "input_hash")).toBe(false);
    expect(isShownColumn(null, "updated_at")).toBe(false);
  });
});

describe("resolveIdFields", () => {
  it("swaps a known id for its name and an unresolved one for a removed-thing label", () => {
    const names = new Map([["commitments.location_id", new Map([["home", "Home"]])]]);
    const fields = [
      { field: "location_id", before: "home", after: "gone", afterKnown: true },
      { field: "title", before: "a", after: "b", afterKnown: true }
    ];
    expect(
      resolveIdFields(fields, new Map([["condition_definitions.location_id", names.get("commitments.location_id")!]]))
    ).toEqual([
      { field: "location_id", before: "Home", after: "a removed place", afterKnown: true },
      { field: "title", before: "a", after: "b", afterKnown: true }
    ]);
  });
  it("leaves a null side alone", () => {
    expect(
      resolveIdFields([{ field: "project_id", before: null, after: null, afterKnown: false }], new Map())[0]
    ).toMatchObject({
      before: null
    });
  });
});

describe("missingPlanReason", () => {
  const base = { before: true, after: false, hasInputVersion: true, ageMs: 60_000 };
  it("is pending for a young write with no matching run yet", () => {
    expect(missingPlanReason(base)).toBe("pending");
  });
  it("is pruned for an old write with no matching run, or no run before it", () => {
    expect(missingPlanReason({ ...base, ageMs: PENDING_WINDOW_MS })).toBe("pruned");
    expect(missingPlanReason({ ...base, before: false })).toBe("unknown");
  });
  it("is unknown without an input version, or when both runs exist but cannot be diffed", () => {
    expect(missingPlanReason({ ...base, hasInputVersion: false })).toBe("unknown");
    expect(missingPlanReason({ ...base, after: true })).toBe("unknown");
  });
});

describe("shareBasis", () => {
  it("gives rows without a basis the write's, and leaves their own alone", () => {
    const rows = shareBasis([
      { basis: null, statedEvidence: null, id: 1 },
      { basis: "stated", statedEvidence: "yes do it", id: 2 },
      { basis: "inferred", statedEvidence: null, id: 3 }
    ]);
    expect(rows.map((row) => [row.basis, row.statedEvidence])).toEqual([
      ["stated", "yes do it"],
      ["stated", "yes do it"],
      ["inferred", "yes do it"]
    ]);
  });
  it("stays empty when no row has one", () => {
    expect(shareBasis([{ basis: null, statedEvidence: null }])).toEqual([{ basis: null, statedEvidence: null }]);
  });
});
