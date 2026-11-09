import { describe, expect, it } from "vitest";
import { validateActivityEvent } from "./activity-events.js";
import { correctedLabelKey, inferredLabelKey } from "./drift/drift-labels.js";
import { DRIFT_THRESHOLDS_VERSION, flagBucket, holdoutAssigned } from "./drift/drift-rules.js";

const now = new Date("2026-11-09T12:00:00.000Z");
const HASH = "a".repeat(64);
const AREA = "11111111-2222-3333-4444-555555555555";

const inferred = (over: Record<string, unknown> = {}, id?: string) => ({
  id: id ?? inferredLabelKey(AREA, HASH, 1, "model:8b"),
  source: "drift",
  kind: "work_label",
  start: "2026-11-09T11:00:00Z",
  attrs: {
    area_id: AREA,
    label: "work",
    origin: "inferred",
    model: { id: "model:8b" },
    input_hash: HASH,
    prompt_version: 1,
    evidence: "names a paid course",
    ...over
  }
});
const corrected = (over: Record<string, unknown> = {}, id?: string) => ({
  id: id ?? correctedLabelKey(AREA, "req-12345678"),
  source: "drift",
  kind: "work_label",
  start: "2026-11-09T11:00:00Z",
  attrs: { area_id: AREA, label: "not_work", origin: "corrected", request_id: "req-12345678", ...over }
});
const flagStart = "2026-11-09T11:00:00Z";
const flag = (over: Record<string, unknown> = {}, id?: string) => {
  const bucket = flagBucket(new Date(flagStart));
  return {
    id: id ?? `user-1|after_shift|${bucket}`,
    source: "drift",
    kind: "flag",
    start: flagStart,
    attrs: {
      rule: "after_shift",
      moment_id: "user-1|1",
      bucket,
      arm: "shadow",
      holdout: holdoutAssigned("user-1|1"),
      thresholds_version: DRIFT_THRESHOLDS_VERSION,
      ...over
    }
  };
};
const reason = (raw: unknown) => {
  const verdict = validateActivityEvent(raw, now);
  return verdict.ok ? null : verdict.reason;
};

describe("source drift, work_label", () => {
  it("accepts an inferred row and a corrected row", () => {
    expect(reason(inferred())).toBeNull();
    expect(reason(corrected())).toBeNull();
    expect(reason(corrected({ label: "unset" }))).toBeNull();
    expect(reason(inferred({ confidence: 0.4, evidence: undefined }))).toBeNull();
  });

  it.each([
    ["an unknown attr", inferred({ note: "x" }), "not allowed"],
    ["a model on a corrected row", corrected({ model: { id: "m" } }), "not allowed"],
    ["an input hash on a corrected row", corrected({ input_hash: HASH }), "not allowed"],
    ["unset from the model", inferred({ label: "unset" }), "attrs.label"],
    ["a label outside the list", corrected({ label: "leisure" }), "attrs.label"],
    ["an origin outside the list", inferred({ origin: "agent" }), "attrs.origin"],
    ["no model", inferred({ model: undefined }), "attrs.model"],
    ["a model with a digest", inferred({ model: { id: "m", digest: "x" } }), "attrs.model"],
    ["a text instead of a hash", inferred({ input_hash: "the area text" }), "input_hash"],
    ["no prompt version", inferred({ prompt_version: undefined }), "prompt_version"],
    ["evidence over 200 characters", inferred({ evidence: "x".repeat(201) }), "evidence"],
    ["confidence above 1", inferred({ confidence: 2 }), "confidence"],
    ["an area id with a separator", inferred({ area_id: "a|b" }), "area_id"],
    ["a request id too short", corrected({ request_id: "x" }), "request_id"],
    ["by", inferred({ by: "me" }), "attrs.by"]
  ])("refuses %s", (_name, raw, expected) => {
    expect(reason(raw)).toContain(expected);
  });

  it("refuses a key that does not follow from the attrs", () => {
    expect(reason(inferred({}, "work_label|other|inferred|x"))).toContain("event id must be");
    expect(reason(corrected({}, "anything"))).toContain("event id must be");
  });

  it("refuses content, an end time, oversize attrs and the generic correction kind", () => {
    expect(reason({ ...inferred(), content: "area words" })).toContain("no content");
    expect(reason({ ...inferred(), end: "2026-11-09T11:30:00Z" })).toContain("instant");
    expect(reason({ ...inferred(), kind: "correction" })).toContain("is not known");
    expect(reason({ ...inferred(), kind: "reason" })).toContain("is not known");
    expect(reason(inferred({ evidence: "x".repeat(200) }))).toBeNull();
  });
});

describe("source drift, flag", () => {
  it("accepts a shadow flag whose fields follow from its own moment", () => {
    expect(reason(flag())).toBeNull();
  });

  it.each([
    ["a rule outside the list", flag({ rule: "other" }), "attrs.rule"],
    ["an arm that sends", flag({ arm: "send" }), "attrs.arm"],
    ["a holdout the moment does not give", flag({ holdout: !holdoutAssigned("user-1|1") }), "attrs.holdout"],
    ["a bucket that is not the start's", flag({ bucket: 1 }), "attrs.bucket"],
    ["another thresholds version", flag({ thresholds_version: 99 }), "thresholds_version"],
    ["a free field", flag({ note: "x" }), "not allowed"]
  ])("refuses %s", (_name, raw, expected) => {
    expect(reason(raw)).toContain(expected);
  });

  it("refuses a key that does not end with rule and bucket", () => {
    expect(reason(flag({}, "user-1|after_shift|1"))).toContain("must end with");
  });
});
