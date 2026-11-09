import { describe, expect, it } from "vitest";
import { ACTIVITY_ATTRS_MAX_BYTES, ACTIVITY_KEY_MAX_CHARS, validateActivityEvent } from "./activity-events.js";
import {
  PHYSIOLOGY_KINDS,
  canonicalPhysiologyKey,
  physiologyJsonSchema,
  physiologyKeyProblem
} from "./activity-physiology.js";

const now = new Date("2026-11-09T12:00:00.000Z");
const HOUR = "2026-11-08T10:00:00.000Z";
const common = { device: "band-1", route: "app", v: 0 };
const scale = { min: 0, max: 100, higher_means: "more stress" };

/** 240 integer bpm readings on a 15 s grid. */
const hourSamples = (extra: Record<string, unknown> = {}) => ({
  unit: "bpm",
  step_s: 15,
  values: Array.from({ length: 240 }, (_, i) => 60 + (i % 20)),
  n: 240,
  min: 60,
  max: 79,
  avg: 69.5,
  coverage_s: 3600,
  src_step_s: 15,
  ...extra
});

const build = (kind: string, attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const start = (extra.start as string | undefined) ?? HOUR;
  const merged = { ...common, ...attrs };
  const id =
    (extra.id as string | undefined) ??
    canonicalPhysiologyKey(kind, merged, new Date(start)) ??
    "unreachable-id-for-test";
  return { id, source: "physiology", kind, start, ...extra, attrs: merged };
};
const reason = (raw: unknown) => {
  const verdict = validateActivityEvent(raw, now);
  return verdict.ok ? null : verdict.reason;
};
const ok = (raw: unknown) => {
  expect(reason(raw)).toBeNull();
};

/** A grid of `step_s` over `period` seconds holding `readings` first and gaps after, with consistent statistics. */
const series = (step_s: number, readings: number[], period = 3600) => {
  const length = Math.ceil(period / step_s);
  const values: (number | null)[] = [...readings, ...Array.from({ length: length - readings.length }, () => null)];
  const sum = readings.reduce((a, b) => a + b, 0);
  return {
    step_s,
    values,
    n: readings.length,
    min: Math.min(...readings),
    max: Math.max(...readings),
    avg: Math.round((sum / readings.length) * 100) / 100,
    coverage_s: readings.length * step_s
  };
};

const valid: Record<string, () => Record<string, unknown>> = {
  heart_rate: () => build("heart_rate", hourSamples()),
  heart_rate_dense: () =>
    build(
      "heart_rate_dense",
      { unit: "bpm", ...series(1, [70, 71, 72], 300), src_step_s: 1 },
      { start: "2026-11-08T10:05:00.000Z" }
    ),
  hrv: () => build("hrv", { unit: "ms", method: "rmssd", ...series(300, [41.5, 42]) }),
  stress: () => build("stress", { scale, ...series(300, [30, 40]) }),
  score_series: () => build("score_series", { score_name: "load", scale, ...series(300, [3.5, 4.5]) }),
  respiration: () => build("respiration", { unit: "br/min", ...series(60, [14.5, 15]) }),
  spo2: () => build("spo2", { unit: "%", ...series(60, [97, 96]) }),
  skin_temp: () => build("skin_temp", { unit: "degC_delta", ...series(60, [-0.5, 0.2]) }),
  steps: () => build("steps", { steps: 420 }),
  movement: () =>
    build("movement", {
      basis: "device_label",
      segments: [
        { start_s: 0, end_s: 600, state: "walking" },
        { start_s: 600, end_s: 3600, state: "sedentary" }
      ]
    }),
  sleep: () =>
    build(
      "sleep",
      {
        local_date: "2026-11-08",
        segments: [
          { start_s: 0, end_s: 3600, stage: "light", stage_raw: "N1" },
          { start_s: 3600, end_s: 7200, stage: "deep" }
        ],
        scores: { quality: { value: 80, scale: { min: 0, max: 100, higher_means: "better" } } }
      },
      { start: "2026-11-07T22:00:00.000Z", end: "2026-11-08T00:00:00.000Z", tzOffsetMin: 660 }
    ),
  daily: () => build("daily", { local_date: "2026-11-08", steps: 9000, resting_hr: 55, kcal_active: 400.5 }),
  score: () => build("score", { score_name: "readiness", scale, value: 70 }),
  workout: () => build("workout", { activity_type: "run", ext_id: "w-1", duration_min: 30, avg_hr: 140, max_hr: 170 })
};

describe("the physiology source", () => {
  it("accepts one valid example of every kind", () => {
    expect(Object.keys(valid).sort()).toEqual([...PHYSIOLOGY_KINDS].sort());
    for (const make of Object.values(valid)) ok(make());
  });

  it("keeps the longest key under the key limit", () => {
    const attrs = {
      device: "d".repeat(64),
      route: "r".repeat(32),
      v: 999,
      score_name: "s".repeat(32),
      scale,
      value: 1
    };
    const key = canonicalPhysiologyKey("score", attrs, new Date(HOUR))!;
    expect(key.length).toBeLessThan(ACTIVITY_KEY_MAX_CHARS);
    const workout = canonicalPhysiologyKey("workout", { ...attrs, ext_id: "e".repeat(64) }, new Date(HOUR))!;
    expect(workout.length).toBeLessThan(ACTIVITY_KEY_MAX_CHARS);
    const correction = `correction|${workout}|999`;
    expect(correction.length).toBeLessThanOrEqual(ACTIVITY_KEY_MAX_CHARS);
  });

  it("makes route irrelevant to the key, so two routes share one identity", () => {
    const a = canonicalPhysiologyKey("heart_rate", { ...common, route: "app" }, new Date(HOUR));
    const b = canonicalPhysiologyKey("heart_rate", { ...common, route: "cloud" }, new Date(HOUR));
    expect(a).toBe("heart_rate|band-1|2026-11-08T10:00:00.000Z|v0");
    expect(b).toBe(a);
  });
});

describe("keys", () => {
  it("rejects a wrong key and states the key it expected", () => {
    const event = { ...valid.heart_rate!(), id: "whatever" };
    expect(reason(event)).toContain('send id "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0"');
  });

  it("rejects a server-made h: key from a shorthand post and says so", () => {
    const text = reason({ ...valid.heart_rate!(), id: "h:0123456789abcdef" })!;
    expect(text).toContain("the server-made id h:0123456789abcdef is not the canonical key");
    expect(text).toContain('send id "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0"');
  });

  it("accepts a shorthand-style event that carries the canonical id", () => {
    ok(valid.heart_rate!());
  });

  it("puts the version in the key, so v1 is a separate row from v0", () => {
    const v1 = build("heart_rate", hourSamples({ v: 1 }));
    expect(v1.id).toBe("heart_rate|band-1|2026-11-08T10:00:00.000Z|v1");
    ok(v1);
    expect(reason({ ...v1, id: "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0" })).toContain("|v1");
  });

  it("uses local_date for sleep and daily, a score_name@period for score, ext_id or the start second for workout", () => {
    expect(valid.sleep!().id).toBe("sleep|band-1|2026-11-08|v0");
    expect(valid.daily!().id).toBe("daily|band-1|2026-11-08|v0");
    expect(valid.score!().id).toBe("score|band-1|readiness@2026-11-08T10:00:00.000Z|v0");
    expect(valid.workout!().id).toBe("workout|band-1|x:w-1|v0");
    const bare = build("workout", { activity_type: "run" }, { start: "2026-11-08T10:00:00.250Z" });
    expect(bare.id).toBe("workout|band-1|2026-11-08T10:00:00Z|v0");
    ok(bare);
    const day = build("score", { score_name: "readiness", scale, value: 70, local_date: "2026-11-08" });
    expect(day.id).toBe("score|band-1|readiness@2026-11-08|v0");
  });
});

describe("common attrs", () => {
  const withAttrs = (patch: Record<string, unknown>) => {
    const event = valid.steps!();
    const attrs = { ...(event.attrs as Record<string, unknown>), ...patch };
    return { ...event, attrs, id: "skip" };
  };
  const first = (patch: Record<string, unknown>) => reason(withAttrs(patch));

  it("requires device, route and v with a fix in each rejection", () => {
    expect(first({ device: undefined })).toMatch(/attrs\.device is missing.*1 to 64/);
    expect(first({ route: undefined })).toMatch(/attrs\.route is missing.*1 to 32/);
    expect(first({ v: undefined })).toMatch(/attrs\.v is missing.*0 to 999/);
  });

  it("limits label characters and lengths, and forbids the pipe", () => {
    expect(first({ device: "a|b" })).toMatch(/attrs\.device.*A-Z a-z 0-9/);
    expect(first({ device: "x".repeat(65) })).toContain("attrs.device");
    expect(first({ route: "x".repeat(33) })).toContain("attrs.route");
    expect(first({ route: "has space" })).toContain("attrs.route");
  });

  it("limits v and collector_version", () => {
    expect(first({ v: 1000 })).toContain("attrs.v");
    expect(first({ v: -1 })).toContain("attrs.v");
    expect(first({ v: 1.5 })).toContain("attrs.v");
    expect(first({ collector_version: "x".repeat(33) })).toContain("collector_version");
    expect(first({ collector_version: 3 })).toContain("collector_version");
  });

  it("rejects an attr outside the kind's closed list and names the allowed ones", () => {
    const text = first({ mood: "ok" })!;
    expect(text).toContain('attrs.mood is not an attr of physiology kind "steps"');
    expect(text).toContain("steps");
  });

  it("ignores the batch device column: only attrs.device is in the key", () => {
    ok({ ...valid.steps!(), device: "something-else" });
  });
});

describe("hourly period rows", () => {
  it("rejects a start that is not on the period boundary and names the boundary", () => {
    const event = { ...valid.heart_rate!(), start: "2026-11-08T10:30:00.000Z" };
    expect(reason(event)).toMatch(/start .* UTC hour.*2026-11-08T10:00:00.000Z/);
    const dense = { ...valid.heart_rate_dense!(), start: "2026-11-08T10:07:00.000Z" };
    expect(reason(dense)).toContain("2026-11-08T10:05:00.000Z");
  });

  it("rejects an end that is not the end of the period", () => {
    expect(reason({ ...valid.steps!(), end: "2026-11-08T10:30:00.000Z" })).toContain("2026-11-08T11:00:00.000Z");
    ok({ ...valid.steps!(), end: "2026-11-08T11:00:00.000Z" });
  });
});

describe("samples", () => {
  const hr = (patch: Record<string, unknown>) => reason(build("heart_rate", hourSamples(patch)));

  it("requires bpm and a step of 15 s or more (or null with t) for heart_rate", () => {
    expect(hr({ unit: "mph" })).toMatch(/attrs\.unit.*"bpm"/);
    expect(hr({ unit: undefined })).toMatch(/attrs\.unit is missing/);
    expect(hr({ step_s: 10 })).toMatch(/step_s.*15.*heart_rate_dense/);
    expect(hr({ step_s: undefined })).toMatch(/step_s is missing/);
  });

  it("requires heart_rate_dense to use 1 to 14 s", () => {
    const dense = hourSamples({ step_s: 15 });
    expect(reason(build("heart_rate_dense", dense, { start: "2026-11-08T10:05:00.000Z" }))).toMatch(/step_s.*1 to 14/);
  });

  it("checks values.length against the period and step, and the 300 cap", () => {
    expect(hr({ values: [70], n: 1, min: 70, max: 70, avg: 70, coverage_s: 15 })).toMatch(/values has 1.*240/);
    const long = hourSamples({ step_s: 15, values: Array.from({ length: 301 }, () => 70), n: 301 });
    expect(reason(build("hrv", { ...long, unit: "ms", method: "rmssd", step_s: 10 }))).toMatch(/at most 300/);
  });

  it("checks n against the non-null count and never accepts an empty period", () => {
    expect(hr({ n: 239 })).toMatch(/attrs\.n is 239.*240/);
    const empty = {
      values: Array.from({ length: 240 }, () => null),
      n: 0,
      min: null,
      max: null,
      avg: null,
      coverage_s: 0
    };
    expect(hr(empty)).toMatch(/no readings.*Do not post an empty period/);
  });

  it("checks min <= avg <= max", () => {
    expect(hr({ avg: 99 })).toMatch(/attrs\.avg/);
    expect(hr({ min: 80 })).toMatch(/attrs\.min/);
  });

  it("limits values to one decimal place, integers for bpm", () => {
    const values = Array.from({ length: 240 }, () => 70.5);
    expect(hr({ values, min: 70.5, max: 70.5, avg: 70.5 })).toMatch(/whole numbers/);
    const hrvValues = Array.from({ length: 12 }, () => 41.55);
    const hrv = (patch: Record<string, unknown>) =>
      reason(
        build(
          "hrv",
          hourSamples({
            unit: "ms",
            method: "sdnn",
            step_s: 300,
            values: hrvValues,
            n: 12,
            min: 41.55,
            max: 41.55,
            avg: 41.55,
            coverage_s: 3600,
            ...patch
          })
        )
      );
    expect(hrv({})).toMatch(/1 decimal place/);
    expect(hrv({ values: Array.from({ length: 12 }, () => 41.5), min: 41.5, max: 41.5, avg: 41.5 })).toBeNull();
    expect(
      hrv({ values: Array.from({ length: 12 }, () => 41.5), min: 41.5, max: 41.5, avg: 41.5, method: "mixed" })
    ).toMatch(/method.*rmssd, sdnn/);
  });

  it("checks coverage_s against n x step_s and the period", () => {
    expect(hr({ n: 240, coverage_s: 3601 })).toMatch(/coverage_s/);
    const sparse = hourSamples({
      values: [70, ...Array.from({ length: 239 }, () => null)],
      n: 1,
      min: 70,
      max: 70,
      avg: 70,
      coverage_s: 16
    });
    expect(hr(sparse)).toMatch(/coverage_s 16 is more than n x step_s \(15\)/);
  });

  it("takes irregular samples with step_s null and sorted t inside the period", () => {
    const base = {
      step_s: null,
      values: [70, 71, 72],
      t: [5, 100, 3599],
      n: 3,
      min: 70,
      max: 72,
      avg: 71,
      coverage_s: 3000
    };
    expect(hr(base)).toBeNull();
    expect(hr({ ...base, t: [5, 5, 3599] })).toMatch(/attrs\.t.*sorted/);
    expect(hr({ ...base, t: [5, 100, 3600] })).toMatch(/attrs\.t.*inside the period/);
    expect(hr({ ...base, t: [5, 100] })).toMatch(/attrs\.t has 2.*values has 3/);
    expect(hr({ ...base, t: undefined })).toMatch(/attrs\.t is missing/);
    expect(hr({ ...base, coverage_s: 3601 })).toMatch(/coverage_s/);
    expect(
      hr({
        ...base,
        t: Array.from({ length: 241 }, (_, i) => i),
        values: Array.from({ length: 241 }, () => 70),
        n: 241
      })
    ).toMatch(/at most 240/);
    expect(hr({ t: [1] })).toMatch(/attrs\.t is only for irregular/);
  });

  it("checks flags: same length, and never alongside a stored value", () => {
    const values = [70, null, ...Array.from({ length: 238 }, () => 71)];
    const base = { values, n: 239, min: 70, max: 71, avg: 71, coverage_s: 3585 };
    const flags = [null, "no_signal", ...Array.from({ length: 238 }, () => null)];
    expect(hr({ ...base, flags })).toBeNull();
    expect(hr({ ...base, flags: [null] })).toMatch(/attrs\.flags has 1.*240/);
    expect(hr({ ...base, flags: ["x", ...flags.slice(1)] })).toMatch(/attrs\.flags\[0\].*null value/);
    expect(hr({ ...base, flags: [null, "Bad Code", ...flags.slice(2)] })).toMatch(/attrs\.flags\[1\]/);
  });

  it("checks tz_change", () => {
    expect(hr({ tz_change: { at_s: 1800, tz_offset_min: 600 } })).toBeNull();
    expect(hr({ tz_change: { at_s: 4000, tz_offset_min: 600 } })).toMatch(/tz_change\.at_s/);
    expect(hr({ tz_change: { at_s: 10, tz_offset_min: 9999 } })).toMatch(/tz_change\.tz_offset_min/);
    expect(hr({ tz_change: { at_s: 10 } })).toMatch(/tz_change/);
  });

  it("requires a scale for stress and score_series, and a score_name for score_series", () => {
    const stress = valid.stress!();
    const noScale = { ...stress, attrs: { ...(stress.attrs as object), scale: undefined }, id: "x" };
    expect(reason(noScale)).toMatch(/attrs\.scale is missing/);
    const badScale = {
      ...stress,
      attrs: { ...(stress.attrs as object), scale: { min: 5, max: 5, higher_means: "x" } },
      id: "x"
    };
    expect(reason(badScale)).toMatch(/scale\.min.*less than/);
    const series = valid.score_series!();
    expect(reason({ ...series, attrs: { ...(series.attrs as object), score_name: undefined }, id: "x" })).toMatch(
      /score_name is missing/
    );
  });

  it("holds the worst-case row under the attrs limit", () => {
    const values = Array.from({ length: 240 }, (_, i) => 100.5 + i / 10 - Math.floor(i / 10) / 1000);
    const rounded = values.map((v) => Math.round(v * 10) / 10);
    const flags = Array.from({ length: 240 }, (_, i) => (i % 2 === 0 ? null : "ok"));
    const t = Array.from({ length: 240 }, (_, i) => i * 14);
    const attrs = {
      ...common,
      device: "d".repeat(64),
      route: "r".repeat(32),
      collector_version: "c".repeat(32),
      score_name: "s".repeat(32),
      scale: { min: -100.5, max: 100.5, higher_means: "h".repeat(64) },
      step_s: null,
      t,
      values: rounded,
      n: 240,
      min: 100.5,
      max: 124.5,
      avg: 112.55,
      coverage_s: 3600,
      src_step_s: 1,
      flags: flags.map((flag) => (flag === null ? null : "c".repeat(16)))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(attrs)).length;
    expect(bytes).toBeLessThan(ACTIVITY_ATTRS_MAX_BYTES);
  });
});

describe("segments", () => {
  const movement = (segments: unknown, extra: Record<string, unknown> = {}, raw: Record<string, unknown> = {}) =>
    reason({ ...build("movement", { basis: "device_label", segments, ...extra }), ...raw });

  it("accepts sorted, non-overlapping segments", () => {
    expect(
      movement([
        { start_s: 0, end_s: 10, state: "running" },
        { start_s: 10, end_s: 20, state: "unknown" }
      ])
    ).toBeNull();
  });

  it("rejects overlap, disorder, empty and out-of-period segments with the fix", () => {
    expect(
      movement([
        { start_s: 0, end_s: 20, state: "active" },
        { start_s: 10, end_s: 30, state: "active" }
      ])
    ).toMatch(/segments\[1\].*overlap/);
    expect(
      movement([
        { start_s: 50, end_s: 60, state: "active" },
        { start_s: 0, end_s: 10, state: "active" }
      ])
    ).toMatch(/segments\[1\].*sorted/);
    expect(movement([{ start_s: 10, end_s: 10, state: "active" }])).toMatch(/start_s 10 must be less than .*end_s 10/);
    expect(movement([{ start_s: 0, end_s: 3601, state: "active" }])).toMatch(/end_s.*3600/);
    expect(movement([])).toMatch(/segments is empty/);
    expect(movement("none")).toMatch(/segments must be a list/);
  });

  it("closes the state list and the segment keys", () => {
    expect(movement([{ start_s: 0, end_s: 10, state: "flying" }])).toMatch(
      /segments\[0\]\.state.*sedentary, active, walking, running, cycling, other, unknown/
    );
    expect(movement([{ start_s: 0, end_s: 10, state: "active", note: "x" }])).toMatch(/segments\[0\]\.note/);
  });

  it("requires approximate true for an inferred basis", () => {
    const attrs = { basis: "inferred", segments: [{ start_s: 0, end_s: 10, state: "active" }] };
    expect(reason(build("movement", attrs))).toMatch(/inferred.*approximate/);
    ok(build("movement", attrs, { approximate: true }));
    expect(reason(build("movement", { ...attrs, basis: "guess" }, { approximate: true }))).toMatch(
      /basis.*device_label, inferred/
    );
  });

  it("checks sleep stages, stage_raw and scores, and needs an end", () => {
    const sleep = valid.sleep!();
    const attrs = sleep.attrs as Record<string, unknown>;
    const withSegments = (segments: unknown) => reason({ ...sleep, attrs: { ...attrs, segments }, id: "x" });
    expect(withSegments([{ start_s: 0, end_s: 100, stage: "nap" }])).toMatch(
      /segments\[0\]\.stage.*in_bed, asleep, awake, light, deep, rem/
    );
    expect(withSegments([{ start_s: 0, end_s: 100, stage: "rem", stage_raw: "x".repeat(33) }])).toMatch(/stage_raw/);
    expect(withSegments([{ start_s: 0, end_s: 7201, stage: "rem" }])).toMatch(/7200/);
    expect(reason({ ...sleep, end: undefined, id: "x" })).toMatch(/sleep needs an end/);
    expect(reason({ ...sleep, attrs: { ...attrs, local_date: "2026-02-30" }, id: "x" })).toMatch(/local_date/);
    expect(reason({ ...sleep, attrs: { ...attrs, local_date: undefined }, id: "x" })).toMatch(/local_date is missing/);
    expect(reason({ ...sleep, attrs: { ...attrs, scores: { q: { value: 1 } } }, id: "x" })).toMatch(/scores\.q\.scale/);
  });
});

describe("other kinds", () => {
  const attrsOf = (kind: string) => valid[kind]!().attrs as Record<string, unknown>;
  const patched = (kind: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    reason({ ...valid[kind]!(), attrs: { ...attrsOf(kind), ...patch }, id: "x", ...extra });

  it("steps is a non-negative integer", () => {
    expect(patched("steps", { steps: -1 })).toMatch(/attrs\.steps/);
    expect(patched("steps", { steps: 1.5 })).toMatch(/attrs\.steps/);
    expect(patched("steps", { steps: undefined })).toMatch(/attrs\.steps is missing/);
  });

  it("daily takes only its closed list and at least one field", () => {
    expect(patched("daily", { mood: 1 })).toMatch(
      /attrs\.mood.*steps, resting_hr, stress_avg, active_min, kcal_active, floors, distance_m, scores/
    );
    expect(patched("daily", { steps: undefined, resting_hr: undefined, kcal_active: undefined })).toMatch(
      /no fields.*empty/
    );
    expect(patched("daily", { steps: 1.5 })).toMatch(/attrs\.steps/);
  });

  it("score needs score_name, scale and a value inside the scale", () => {
    expect(patched("score", { value: 101 })).toMatch(/attrs\.value 101.*0 to 100/);
    expect(patched("score", { score_name: "bad|name" })).toMatch(/score_name/);
    expect(patched("score", { score_name: "x".repeat(33) })).toMatch(/score_name/);
  });

  it("workout needs activity_type and checks its numbers", () => {
    expect(patched("workout", { activity_type: undefined })).toMatch(/activity_type is missing/);
    expect(patched("workout", { max_hr: 100 })).toMatch(/max_hr.*avg_hr/);
    expect(patched("workout", { ext_id: "bad|id" })).toMatch(/ext_id/);
    expect(patched("workout", { duration_min: -1 })).toMatch(/duration_min/);
  });

  it("rejects an unknown kind of the physiology source with the allowed list", () => {
    const text = reason({ ...valid.steps!(), kind: "blood_pressure" })!;
    expect(text).toContain("heart_rate_dense");
    expect(text).toContain("correction");
  });
});

describe("corrections", () => {
  const target = "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0";
  const correction = (attrs: Record<string, unknown>, id = `correction|${target}|0`) => ({
    id,
    source: "physiology",
    kind: "correction",
    start: HOUR,
    attrs
  });

  it("accepts a void and a fix with the canonical key", () => {
    ok(correction({ corrects: target, void: true }));
    ok(correction({ corrects: target, fix: { avg: 70 } }, `correction|${target}|1`));
  });

  it("needs exactly one of void and fix, a physiology target key and the canonical id", () => {
    expect(reason(correction({ corrects: target }))).toMatch(/exactly one of void or fix/);
    expect(reason(correction({ corrects: target, void: true, fix: { avg: 1 } }))).toMatch(/exactly one of void or fix/);
    expect(reason(correction({ corrects: target, void: false }))).toMatch(/void must be true/);
    expect(reason(correction({ corrects: target, fix: {} }))).toMatch(/attrs\.fix/);
    expect(reason(correction({ corrects: "nonsense", void: true }))).toMatch(/attrs\.corrects/);
    expect(reason(correction({ void: true }))).toMatch(/attrs\.corrects is missing/);
    expect(reason(correction({ corrects: target, void: true }, "c1"))).toContain(`correction|${target}|<n>`);
    expect(reason(correction({ corrects: target, void: true, extra: 1 }))).toMatch(/attrs\.extra/);
  });
});

describe("other sources", () => {
  it("leaves every other source unvalidated by this module", () => {
    expect(reason({ id: "k", source: "fit", kind: "steps", start: HOUR, attrs: { anything: 1 } })).toBeNull();
    expect(
      reason({ id: "k", source: "iphone-health", kind: "steps_day", start: HOUR, attrs: { steps: 9 } })
    ).toBeNull();
  });
});

describe("review fixes", () => {
  const heart = (patch: Record<string, unknown>) => reason(build("heart_rate", hourSamples(patch)));

  it("fails closed when the canonical key cannot be computed", () => {
    const problem = physiologyKeyProblem({
      id: "x",
      kind: "steps",
      tsStart: new Date(HOUR),
      tsEnd: null,
      approximate: false,
      content: null,
      attrs: { route: "app", v: 0 }
    });
    expect(problem).toMatch(/cannot compute the canonical key.*attrs\.device/);
  });

  it("allows no leading zeros in a correction's n or in the target's version", () => {
    const target = "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0";
    const fix = (corrects: string, n: string) => ({
      id: `correction|${corrects}|${n}`,
      source: "physiology",
      kind: "correction",
      start: HOUR,
      attrs: { corrects, void: true }
    });
    expect(reason(fix(target, "0"))).toBeNull();
    expect(reason(fix(target, "999"))).toBeNull();
    expect(reason(fix(target, "007"))).toMatch(/not the canonical key/);
    expect(reason(fix(target, "1000"))).toMatch(/not the canonical key/);
    expect(reason(fix("heart_rate|band-1|2026-11-08T10:00:00.000Z|v01", "0"))).toMatch(/attrs\.corrects/);
    expect(reason(fix(target.replace("v0", "v1000"), "0"))).toMatch(/attrs\.corrects/);
  });

  it("requires corrects to be a well-formed physiology key: kind, labels, period and version", () => {
    const check = (corrects: string) =>
      reason({
        id: `correction|${corrects}|0`,
        source: "physiology",
        kind: "correction",
        start: HOUR,
        attrs: { corrects, void: true }
      });
    expect(check("heart_rate|band-1|2026-11-08T10:00:00.000Z|v0")).toBeNull();
    expect(check("sleep|band-1|2026-11-08|v3")).toBeNull();
    expect(check("score|band-1|readiness@2026-11-08|v0")).toBeNull();
    expect(check("workout|band-1|x:w-1|v0")).toBeNull();
    expect(check("workout|band-1|2026-11-08T10:00:00Z|v0")).toBeNull();
    expect(check("correction|heart_rate|a|b")).toMatch(/attrs\.corrects/);
    expect(check("heart_rate|bad dev|2026-11-08T10:00:00.000Z|v0")).toMatch(/attrs\.corrects.*device/);
    expect(check("heart_rate|band-1|yesterday|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("heart_rate|band-1|2026-11-08T10:30:00.000Z|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("sleep|band-1|2026-02-30|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("score|band-1|readiness|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("workout|band-1|x:|v0")).toMatch(/attrs\.corrects.*period/);
  });

  it("bounds the reading values per kind and unit", () => {
    expect(heart({ values: [...Array.from({ length: 239 }, () => 70), 19], min: 19, max: 70, avg: 69.5 })).toMatch(
      /values\[239\] 19.*20 to 260/
    );
    expect(heart({ values: [...Array.from({ length: 239 }, () => 70), 261], min: 70, max: 261, avg: 70.8 })).toMatch(
      /261.*20 to 260/
    );
    const one = (kind: string, attrs: Record<string, unknown>, value: number) =>
      reason(build(kind, { ...attrs, ...series(60, [value]) }));
    expect(one("spo2", { unit: "%" }, 49)).toMatch(/50 to 100/);
    expect(one("spo2", { unit: "%" }, 100)).toBeNull();
    expect(one("spo2", { unit: "%" }, 101)).toMatch(/50 to 100/);
    expect(one("respiration", { unit: "br/min" }, -1)).toMatch(/0 to 80/);
    expect(one("respiration", { unit: "br/min" }, 81)).toMatch(/0 to 80/);
    expect(one("skin_temp", { unit: "degC" }, 60)).toMatch(/10 to 45/);
    expect(one("skin_temp", { unit: "degC_delta" }, 16)).toMatch(/-15 to 15/);
    expect(one("skin_temp", { unit: "degC_delta" }, -16)).toMatch(/-15 to 15/);
    expect(reason(build("hrv", { unit: "ms", method: "rmssd", ...series(300, [-3]) }))).toMatch(/0 to 500/);
    expect(reason(build("hrv", { unit: "ms", method: "rmssd", ...series(300, [501]) }))).toMatch(/0 to 500/);
    expect(
      reason(
        build("heart_rate_dense", { unit: "bpm", ...series(1, [300], 300) }, { start: "2026-11-08T10:05:00.000Z" })
      )
    ).toMatch(/20 to 260/);
  });

  it("holds stress and score_series values to their scale", () => {
    expect(reason(build("stress", { scale, ...series(300, [30, 101]) }))).toMatch(/values\[1\] 101.*scale.*0 to 100/);
    expect(reason(build("score_series", { score_name: "load", scale, ...series(300, [-1]) }))).toMatch(
      /scale.*0 to 100/
    );
    expect(reason(build("stress", { scale, ...series(300, [0, 100]) }))).toBeNull();
  });

  it("requires min and max to equal the true min and max, and avg to match the mean within 0.05", () => {
    const base = series(300, [10.5, 20.5, 30.5]);
    const hrv = (patch: Record<string, unknown>) =>
      reason(build("hrv", { unit: "ms", method: "sdnn", ...base, ...patch }));
    expect(hrv({})).toBeNull();
    expect(hrv({ min: 10 })).toMatch(/attrs\.min 10 is not the smallest value \(10\.5\)/);
    expect(hrv({ max: 99 })).toMatch(/attrs\.max 99 is not the largest value \(30\.5\)/);
    expect(hrv({ avg: 20.56 })).toMatch(/attrs\.avg 20\.56.*mean 20\.5.*0\.05/);
    expect(hrv({ avg: 20.54 })).toBeNull();
    expect(hrv({ avg: 20.46 })).toBeNull();
  });

  it("requires step_s to divide the period", () => {
    expect(reason(build("hrv", { unit: "ms", method: "rmssd", ...series(13, [40]) }))).toMatch(
      /step_s 13 does not divide .*3600/
    );
    expect(heart({ step_s: 17, values: Array.from({ length: 212 }, () => 70), n: 225, coverage_s: 3600 })).toMatch(
      /step_s 17 does not divide/
    );
    expect(
      reason(build("heart_rate_dense", { unit: "bpm", ...series(7, [70], 300) }, { start: "2026-11-08T10:05:00.000Z" }))
    ).toMatch(/step_s 7 does not divide .*300/);
    expect(
      reason(
        build("heart_rate_dense", { unit: "bpm", ...series(12, [70], 300) }, { start: "2026-11-08T10:05:00.000Z" })
      )
    ).toBeNull();
  });

  it("rejects free content on every physiology row", () => {
    expect(reason({ ...valid.steps!(), content: "note" })).toMatch(/content.*physiology/);
    expect(reason({ ...valid.steps!(), content: null })).toBeNull();
  });

  it("accepts unit_raw on a converted non-sampled row, and requires unit ms for hrv", () => {
    ok(build("daily", { local_date: "2026-11-08", distance_m: 1609, unit_raw: "mi" }));
    ok(build("steps", { steps: 3, unit_raw: "count" }));
    expect(reason(build("hrv", { method: "rmssd", ...series(300, [40]) }))).toMatch(/attrs\.unit is missing.*"ms"/);
  });

  it("bounds heart rates in daily and workout rows", () => {
    expect(reason(build("daily", { local_date: "2026-11-08", resting_hr: 5 }))).toMatch(/resting_hr/);
    expect(reason(build("workout", { activity_type: "run", avg_hr: 400 }))).toMatch(/avg_hr/);
  });
});

/**
 * A small validator for the JSON Schema keywords the published physiology schema uses, so the fixtures below are
 * checked against the published schema and the TypeScript rules cannot drift from it. (A full validator such as ajv is not a
 * direct dependency of any workspace package, and this change does not touch the lockfile.)
 */
type Schema = Record<string, any>;
function schemaErrors(schema: Schema, value: unknown, root: Schema, path = "$"): string[] {
  if (schema.$ref !== undefined) {
    const target = (schema.$ref as string)
      .slice(2)
      .split("/")
      .reduce<any>((node, key) => node?.[key], root);
    return target === undefined ? [`${path}: unresolved ${schema.$ref}`] : schemaErrors(target, value, root, path);
  }
  const errors: string[] = [];
  const kindOf = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = kindOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number")))
      return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items !== undefined)
      value.forEach((item, i) => errors.push(...schemaErrors(schema.items, item, root, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const defined = Object.keys(record).filter((key) => record[key] !== undefined);
    for (const key of schema.required ?? []) if (record[key] === undefined) errors.push(`${path}: missing ${key}`);
    if (schema.minProperties !== undefined && defined.length < schema.minProperties)
      errors.push(`${path}: too few properties`);
    if (schema.maxProperties !== undefined && defined.length > schema.maxProperties)
      errors.push(`${path}: too many properties`);
    for (const key of defined) {
      if (schema.propertyNames !== undefined)
        errors.push(...schemaErrors(schema.propertyNames, key, root, `${path}.${key}#name`));
      const own = schema.properties?.[key];
      if (own !== undefined) errors.push(...schemaErrors(own, record[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === "object")
        errors.push(...schemaErrors(schema.additionalProperties, record[key], root, `${path}.${key}`));
    }
  }
  for (const part of schema.allOf ?? []) errors.push(...schemaErrors(part, value, root, path));
  if (schema.if !== undefined && schemaErrors(schema.if, value, root, path).length === 0 && schema.then !== undefined)
    errors.push(...schemaErrors(schema.then, value, root, path));
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((option: Schema) => schemaErrors(option, value, root, path).length === 0);
    if (matching.length !== 1) errors.push(`${path}: matches ${matching.length} of oneOf`);
  }
  return errors;
}

describe("review nits", () => {
  const hrv = (patch: Record<string, unknown>, readings = [10.5, 20.5, 31.5]) =>
    reason(build("hrv", { unit: "ms", method: "sdnn", ...series(300, readings), ...patch }));

  it("accepts an avg rounded to the precision the collector posts, and refuses a wrong one", () => {
    // True mean 20.8333.
    expect(hrv({ avg: 21 })).toBeNull();
    expect(hrv({ avg: 20.8 })).toBeNull();
    expect(hrv({ avg: 20.83 })).toBeNull();
    expect(hrv({ avg: 20.9 })).toMatch(/attrs\.avg 20\.9.*0\.05/);
    expect(hrv({ avg: 20.89 })).toMatch(/attrs\.avg/);
    expect(hrv({ avg: 22 })).toMatch(/attrs\.avg 22.*0\.5/);
  });

  it("lets a whole-number avg sit just outside min and max by its rounding", () => {
    expect(hrv({ avg: 70 }, [70.4])).toBeNull();
    expect(hrv({ avg: 71 }, [70.4])).toMatch(/attrs\.avg/);
  });

  it("checks calendar dates and times strictly, not with Date.parse", () => {
    const check = (corrects: string) =>
      reason({
        id: `correction|${corrects}|0`,
        source: "physiology",
        kind: "correction",
        start: HOUR,
        attrs: { corrects, void: true }
      });
    expect(check("heart_rate|band-1|2026-02-30T10:00:00.000Z|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("steps|band-1|2026-04-31T10:00:00.000Z|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("workout|band-1|2026-02-30T10:00:00Z|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("score|band-1|readiness@2026-02-30T10:00:00.000Z|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("score|band-1|readiness@2026-02-30|v0")).toMatch(/attrs\.corrects.*period/);
    expect(check("heart_rate|band-1|2026-02-28T10:00:00.000Z|v0")).toBeNull();
    expect(check("workout|band-1|2028-02-29T10:00:00Z|v0")).toBeNull();
  });
});

describe("the published schema and the validator agree", () => {
  // portal/server/physiology-schema.test.ts pins the published file to this function, so this is the published schema.
  const published = JSON.parse(JSON.stringify(physiologyJsonSchema())) as Schema;
  const violations = (event: unknown) => schemaErrors(published, event, published);
  const correction = {
    id: "correction|heart_rate|band-1|2026-11-08T10:00:00.000Z|v0|0",
    source: "physiology",
    kind: "correction",
    start: HOUR,
    attrs: { corrects: "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0", void: true }
  };

  it("accepts every valid fixture, one per kind and the corrections", () => {
    for (const [kind, make] of Object.entries(valid)) {
      const event = JSON.parse(JSON.stringify(make()));
      expect(violations(event), kind).toEqual([]);
    }
    expect(violations(correction)).toEqual([]);
    expect(violations({ ...correction, attrs: { corrects: correction.attrs.corrects, fix: { avg: 70 } } })).toEqual([]);
    expect(violations({ ...correction, attrs: { corrects: correction.attrs.corrects } })).not.toEqual([]);
  });

  it("refuses what the validator refuses, for a sample of mistakes per kind", () => {
    const bad = (kind: string, patch: Record<string, unknown>) => {
      const event = JSON.parse(JSON.stringify(valid[kind]!()));
      event.attrs = { ...event.attrs, ...patch };
      return event;
    };
    const cases: [string, Record<string, unknown>][] = [
      ["heart_rate", { unit: "mph" }],
      ["heart_rate", { step_s: 10 }],
      ["heart_rate", { v: 1000 }],
      ["heart_rate", { device: "has space" }],
      ["heart_rate_dense", { step_s: 15 }],
      ["hrv", { method: "mixed" }],
      ["stress", { scale: { min: 0, max: 100 } }],
      ["score_series", { score_name: undefined }],
      ["spo2", { unit: "ppm" }],
      ["skin_temp", { unit: "kelvin" }],
      ["steps", { steps: -1 }],
      ["steps", { mood: 1 }],
      ["movement", { basis: "guess" }],
      ["movement", { segments: [{ start_s: 0, end_s: 10, state: "flying" }] }],
      ["sleep", { segments: [{ start_s: 0, end_s: 10, stage: "nap" }] }],
      ["daily", { floors: 1.5 }],
      ["score", { scale: undefined }],
      ["workout", { activity_type: undefined }],
      ["daily", { resting_hr: 5 }],
      ["daily", { resting_hr: 300 }],
      ["workout", { avg_hr: 19 }],
      ["workout", { max_hr: 261 }]
    ];
    for (const [kind, patch] of cases) {
      expect(violations(bad(kind, patch)), `${kind} ${JSON.stringify(patch)}`).not.toEqual([]);
      const event = bad(kind, patch);
      const id = canonicalPhysiologyKey(kind, event.attrs, new Date(event.start)) ?? "x";
      const why = reason({ ...event, id });
      expect(why, `${kind} ${JSON.stringify(patch)}`).not.toBeNull();
      expect(why, `${kind} ${JSON.stringify(patch)}`).not.toMatch(/canonical key/);
    }
  });

  it("lists exactly the kinds the registry accepts", () => {
    expect(published.properties.kind.enum).toEqual([...PHYSIOLOGY_KINDS, "correction"]);
    expect(Object.keys(published.$defs.attrs).sort()).toEqual([...PHYSIOLOGY_KINDS, "correction"].sort());
  });
});
