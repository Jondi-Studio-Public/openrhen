import { describe, expect, it } from "vitest";
import { REASON_TAG_INFERRED_VIA, type ReasonRow } from "./drift-reasons.js";
import {
  REASON_TAG_WINDOW_DAYS,
  needsModelTags,
  resolveReasonTags,
  type CurrentTagging,
  type ReasonTagRow
} from "./drift-reason-tags.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute));
const NOW: CurrentTagging = { promptVersion: 2, modelId: "model:8b" };

const reason = (checkInId: string, text: string, minute: number, over: Partial<ReasonRow> = {}): ReasonRow => ({
  id: `reason|${checkInId}|r${minute}`,
  checkInId,
  text,
  ingestedAt: at(minute),
  ingestedVia: null,
  ...over
});
const inferred = (
  checkInId: string,
  tags: string[],
  minute: number,
  over: Partial<ReasonTagRow> = {}
): ReasonTagRow => ({
  id: `reason_tag|${checkInId}|inferred|${minute}`,
  checkInId,
  tags,
  origin: "inferred",
  reset: false,
  promptVersion: 2,
  modelId: "model:8b",
  ingestedAt: at(minute),
  ingestedVia: REASON_TAG_INFERRED_VIA,
  ...over
});
const corrected = (
  checkInId: string,
  tags: string[],
  minute: number,
  over: Partial<ReasonTagRow> = {}
): ReasonTagRow => ({
  id: `reason_tag|${checkInId}|corrected|${minute}`,
  checkInId,
  tags,
  origin: "corrected",
  reset: false,
  promptVersion: null,
  modelId: null,
  ingestedAt: at(minute),
  ingestedVia: null,
  ...over
});
const tagsOf = (rows: ReasonTagRow[], reasons: ReasonRow[] = [reason(A, "synthetic words", 0)]) =>
  resolveReasonTags(rows, reasons, NOW).get(A);

describe("resolveReasonTags", () => {
  it("returns the words beside no tags when nothing tagged the reason", () => {
    expect(tagsOf([])).toMatchObject({ text: "synthetic words", tags: [], origin: null, stale: false, at: null });
  });

  it("shows the model's tags when it made them under the current prompt and model", () => {
    expect(tagsOf([inferred(A, ["noise"], 1)])).toMatchObject({ tags: ["noise"], origin: "inferred", stale: false });
  });

  it("accepts an empty list from the model as an answer that there is nothing to tag", () => {
    const resolved = tagsOf([inferred(A, [], 1)])!;
    expect(resolved).toMatchObject({ tags: [], origin: "inferred", stale: false });
    expect(needsModelTags(resolved)).toBe(false);
  });

  it("lets the owner's latest answer win over the model's, whenever the model's landed", () => {
    expect(tagsOf([corrected(A, ["my phrase"], 1), inferred(A, ["noise"], 2)])).toMatchObject({
      tags: ["my phrase"],
      origin: "corrected"
    });
  });

  it("counts an owner answer with no tags as an answer, and leaves the model alone", () => {
    const resolved = tagsOf([inferred(A, ["noise"], 1), corrected(A, [], 2)])!;
    expect(resolved).toMatchObject({ tags: [], origin: "corrected" });
    expect(needsModelTags(resolved)).toBe(false);
  });

  it("takes an explicit reset as the owner taking the answer back, so the model's tags show again", () => {
    expect(
      tagsOf([inferred(A, ["noise"], 1), corrected(A, ["mine"], 2), corrected(A, [], 3, { reset: true })])
    ).toMatchObject({ tags: ["noise"], origin: "inferred" });
    expect(tagsOf([corrected(A, ["mine"], 1), corrected(A, [], 2, { reset: true })])).toMatchObject({
      tags: [],
      origin: null
    });
  });

  it("reverts A to B to A: the latest answer wins, and a reset then a new answer counts again", () => {
    const rows = [corrected(A, ["a"], 1), corrected(A, ["b"], 2), corrected(A, ["a"], 3)];
    expect(tagsOf(rows)?.tags).toEqual(["a"]);
    expect(tagsOf(rows.slice(0, 2))?.tags).toEqual(["b"]);
    expect(tagsOf([...rows, corrected(A, [], 4, { reset: true }), corrected(A, ["c"], 5)])?.tags).toEqual(["c"]);
  });

  it("orders by the time the server stored a row, then by id, whatever order the rows arrive in", () => {
    const early = corrected(A, ["early"], 1);
    const late = corrected(A, ["late"], 2);
    expect(tagsOf([late, early])?.tags).toEqual(["late"]);
    expect(tagsOf([early, late])?.tags).toEqual(["late"]);
    const sameMinuteLow = corrected(A, ["low"], 3, { id: "reason_tag|a|corrected|aaaaaaaa" });
    const sameMinuteHigh = corrected(A, ["high"], 3, { id: "reason_tag|a|corrected|zzzzzzzz" });
    expect(tagsOf([sameMinuteHigh, sameMinuteLow])?.tags).toEqual(["high"]);
    expect(tagsOf([sameMinuteLow, sameMinuteHigh])?.tags).toEqual(["high"]);
  });

  it("ignores rows whose writer does not match their origin", () => {
    expect(tagsOf([corrected(A, ["forged"], 1, { ingestedVia: "some-agent" })])).toMatchObject({ origin: null });
    expect(tagsOf([inferred(A, ["forged"], 1, { ingestedVia: null })])).toMatchObject({ origin: null });
    expect(tagsOf([inferred(A, ["forged"], 1, { ingestedVia: "other" })])).toMatchObject({ origin: null });
  });

  it("keeps the old model's tags, marked stale, until tags under the new prompt or model land", () => {
    const old = inferred(A, ["old"], 1, { promptVersion: 1 });
    expect(tagsOf([old])).toMatchObject({ tags: ["old"], origin: "inferred", stale: true });
    expect(needsModelTags(tagsOf([old])!)).toBe(true);
    const otherModel = inferred(A, ["other"], 1, { modelId: "model:70b" });
    expect(tagsOf([otherModel])).toMatchObject({ stale: true });
    // Once the new ones land they win, even if an old run lands later than them.
    expect(tagsOf([old, inferred(A, ["new"], 2), inferred(A, ["late old"], 3, { promptVersion: 1 })])).toMatchObject({
      tags: ["new"],
      stale: false
    });
  });

  it("marks the model's tags stale when no model is set, but still shows them", () => {
    expect(
      resolveReasonTags([inferred(A, ["noise"], 1)], [reason(A, "w", 0)], { promptVersion: 2, modelId: null }).get(A)
    ).toMatchObject({ tags: ["noise"], stale: true });
  });

  it("ignores the model's tags made before the reason's current words were saved, and keeps the owner's", () => {
    const reasons = [reason(A, "first words", 0), reason(A, "second words", 10)];
    expect(tagsOf([inferred(A, ["about the first"], 5)], reasons)).toMatchObject({
      text: "second words",
      tags: [],
      origin: null
    });
    expect(tagsOf([inferred(A, ["about the first"], 5), corrected(A, ["mine"], 6)], reasons)?.tags).toEqual(["mine"]);
    expect(tagsOf([inferred(A, ["about the second"], 11)], reasons)?.tags).toEqual(["about the second"]);
  });

  it("resolves each check-in on its own and drops tag rows that have no reason", () => {
    const out = resolveReasonTags(
      [inferred(A, ["a"], 1), inferred(B, ["b"], 1), inferred("33333333-3333-4333-8333-333333333333", ["gone"], 1)],
      [reason(A, "one", 0), reason(B, "two", 0)],
      NOW
    );
    expect([...out.keys()].sort()).toEqual([A, B]);
    expect(out.get(B)?.tags).toEqual(["b"]);
  });

  it("does not change the rows it is given", () => {
    const rows = [inferred(A, ["noise"], 1)];
    const copy = JSON.stringify(rows);
    const out = tagsOf(rows)!;
    out.tags.push("added");
    expect(JSON.stringify(rows)).toBe(copy);
  });

  it("names a window of days", () => expect(REASON_TAG_WINDOW_DAYS).toBe(14));
});
