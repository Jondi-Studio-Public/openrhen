import { describe, expect, it } from "vitest";
import {
  WORK_LABEL_INFERRED_VIA,
  correctedLabelKey,
  inferredLabelKey,
  labelOf,
  resolveWorkLabels,
  workItemPredicate,
  type CurrentLabelInput,
  type WorkLabelRow
} from "./drift-labels.js";

const T0 = Date.parse("2026-11-09T09:00:00.000Z");
const hash = (n: number) => String(n).repeat(64).slice(0, 64);
let counter = 0;
function row(over: Partial<WorkLabelRow> & Pick<WorkLabelRow, "areaId" | "origin" | "label">): WorkLabelRow {
  counter += 1;
  return {
    id: `row-${String(counter).padStart(4, "0")}`,
    inputHash: over.origin === "inferred" ? hash(1) : null,
    promptVersion: over.origin === "inferred" ? 1 : null,
    tsStart: new Date(T0 + counter * 60_000),
    ingestedAt: new Date(T0 + counter * 60_000),
    ingestedVia: over.origin === "inferred" ? WORK_LABEL_INFERRED_VIA : null,
    ...over
  };
}
const current = (entries: Record<string, CurrentLabelInput>) => new Map(Object.entries(entries));
const now1 = { inputHash: hash(1), promptVersion: 1 };

describe("resolveWorkLabels", () => {
  it("is unknown for an area with no row, and never work", () => {
    const labels = resolveWorkLabels([], current({ a: now1 }));
    expect(labelOf(labels, "a")).toMatchObject({ value: "unknown", origin: null });
  });

  it("reads the inferred label made from the area's current text and prompt", () => {
    const labels = resolveWorkLabels([row({ areaId: "a", origin: "inferred", label: "work" })], current({ a: now1 }));
    expect(labelOf(labels, "a")).toMatchObject({ value: "work", origin: "inferred" });
  });

  it("ignores an inferred row made from other text or another prompt version", () => {
    const rows = [
      row({ areaId: "a", origin: "inferred", label: "work", inputHash: hash(2) }),
      row({ areaId: "a", origin: "inferred", label: "work", promptVersion: 2 })
    ];
    expect(labelOf(resolveWorkLabels(rows, current({ a: now1 })), "a").value).toBe("unknown");
  });

  it("reads A again after the text goes A to B to A (the revert), not the label B got", () => {
    const rows = [
      row({ areaId: "a", origin: "inferred", label: "work", inputHash: hash(1) }),
      row({ areaId: "a", origin: "inferred", label: "not_work", inputHash: hash(2) })
    ];
    const back = resolveWorkLabels(rows, current({ a: { inputHash: hash(1), promptVersion: 1 } }));
    expect(labelOf(back, "a")).toMatchObject({ value: "work", origin: "inferred" });
    const onB = resolveWorkLabels(rows, current({ a: { inputHash: hash(2), promptVersion: 1 } }));
    expect(labelOf(onB, "a").value).toBe("not_work");
    const onC = resolveWorkLabels(rows, current({ a: { inputHash: hash(3), promptVersion: 1 } }));
    expect(labelOf(onC, "a").value).toBe("unknown");
  });

  it("lets the owner's answer beat an inferred row made later, whatever the text now is", () => {
    const rows = [
      row({ areaId: "a", origin: "corrected", label: "not_work" }),
      row({ areaId: "a", origin: "inferred", label: "work" })
    ];
    expect(labelOf(resolveWorkLabels(rows, current({ a: now1 })), "a")).toMatchObject({
      value: "not_work",
      origin: "corrected"
    });
    expect(labelOf(resolveWorkLabels(rows, current({ a: { inputHash: hash(9), promptVersion: 1 } })), "a").value).toBe(
      "not_work"
    );
  });

  it("takes the owner's latest answer", () => {
    const rows = [
      row({ areaId: "a", origin: "corrected", label: "work" }),
      row({ areaId: "a", origin: "corrected", label: "not_work" })
    ];
    expect(labelOf(resolveWorkLabels(rows, current({})), "a").value).toBe("not_work");
  });

  it("falls back to the matching inferred row after an explicit reset", () => {
    const rows = [
      row({ areaId: "a", origin: "inferred", label: "work" }),
      row({ areaId: "a", origin: "corrected", label: "not_work" }),
      row({ areaId: "a", origin: "corrected", label: "unset" })
    ];
    expect(labelOf(resolveWorkLabels(rows, current({ a: now1 })), "a")).toMatchObject({
      value: "work",
      origin: "inferred"
    });
    expect(labelOf(resolveWorkLabels(rows, current({})), "a").value).toBe("unknown");
  });

  it("breaks a tie on start time by arrival time, then by id", () => {
    const at = new Date(T0);
    const a = row({ areaId: "a", origin: "corrected", label: "work", tsStart: at, ingestedAt: new Date(T0 + 1) });
    const b = row({ areaId: "a", origin: "corrected", label: "not_work", tsStart: at, ingestedAt: new Date(T0 + 2) });
    expect(labelOf(resolveWorkLabels([b, a], current({})), "a").value).toBe("not_work");
    const c = row({ id: "aaa", areaId: "a", origin: "corrected", label: "work", tsStart: at, ingestedAt: at });
    const d = row({ id: "bbb", areaId: "a", origin: "corrected", label: "not_work", tsStart: at, ingestedAt: at });
    expect(labelOf(resolveWorkLabels([d, c], current({})), "a").value).toBe("not_work");
    expect(labelOf(resolveWorkLabels([c, d], current({})), "a").value).toBe("not_work");
  });

  it("ignores rows from the wrong writer: a forged correction, a forged inference, or an inferred unset", () => {
    const rows = [
      row({ areaId: "a", origin: "corrected", label: "work", ingestedVia: "phone" }),
      row({ areaId: "a", origin: "inferred", label: "work", ingestedVia: null }),
      row({ areaId: "a", origin: "inferred", label: "unset" })
    ];
    expect(resolveWorkLabels(rows, current({ a: now1 })).size).toBe(0);
  });

  it("gives an area missing from the current inputs (private, unreadable) no inferred label, and keeps the owner's own", () => {
    const rows = [
      row({ areaId: "p", origin: "inferred", label: "work" }),
      row({ areaId: "q", origin: "corrected", label: "work" })
    ];
    const labels = resolveWorkLabels(rows, current({}));
    expect(labelOf(labels, "p").value).toBe("unknown");
    expect(labelOf(labels, "q").value).toBe("work");
  });
});

describe("workItemPredicate", () => {
  const rows = [
    row({ areaId: "w", origin: "inferred", label: "work" }),
    row({ areaId: "n", origin: "inferred", label: "not_work" })
  ];
  const labels = resolveWorkLabels(rows, current({ w: now1, n: now1, u: now1 }));
  const areaOf = (item: unknown) => ({ i1: "w", i2: "n", i3: "u" })[item as string];
  const isWork = workItemPredicate(labels, areaOf);

  it("is true only for an item in an area labelled work", () => {
    expect(isWork("i1")).toBe(true);
    expect(isWork("i2")).toBe(false);
    expect(isWork("i3")).toBe(false);
    expect(isWork("no-area")).toBe(false);
    expect(isWork(undefined)).toBe(false);
  });
});

describe("keys", () => {
  it("name the area, text hash, prompt version and model, so any change writes a new row", () => {
    const key = inferredLabelKey("area-1", hash(1), 2, "model:8b");
    expect(key).toBe(`work_label|area-1|inferred|${hash(1)}|v2|model:8b`);
    expect(key).not.toBe(inferredLabelKey("area-1", hash(1), 3, "model:8b"));
    expect(key).not.toBe(inferredLabelKey("area-1", hash(1), 2, "model:9b"));
    expect(key.length).toBeLessThan(200);
  });
  it("name the request for a correction, so a retried tap writes once", () => {
    expect(correctedLabelKey("area-1", "req-12345678")).toBe("work_label|area-1|corrected|req-12345678");
  });
});
