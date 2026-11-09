/**
 * The generic physiology vocabulary: the kinds of source `physiology`, the attrs each must carry, the one canonical
 * key rule, and the pure validator `validateActivityEvent` applies to every writer (the way it applies
 * `describeDerivedProblem` to `derived`). Pure, never throws. The reasons name the field and the exact fix, because the
 * poster is often an automation. It reads no collector state and names no vendor: a collector maps its own data onto
 * these kinds and posts it. Information only: nothing here may change what the plan allows, and the engine never
 * imports this module. See docs/operations/posting-physiology-data.md and docs/architecture/activity-store.md.
 */

export const PHYSIOLOGY_SOURCE = "physiology";
export const PHYSIOLOGY_SCHEMA_VERSION = 1;

/** Kinds whose period is one UTC hour, as a series of samples. */
export const PHYSIOLOGY_SAMPLED_KINDS = [
  "heart_rate",
  "heart_rate_dense",
  "hrv",
  "stress",
  "score_series",
  "respiration",
  "spo2",
  "skin_temp"
] as const;
export const PHYSIOLOGY_KINDS = [
  ...PHYSIOLOGY_SAMPLED_KINDS,
  "steps",
  "movement",
  "sleep",
  "daily",
  "score",
  "workout"
] as const;

export const PHYSIOLOGY_DEVICE_MAX_CHARS = 64;
export const PHYSIOLOGY_ROUTE_MAX_CHARS = 32;
export const PHYSIOLOGY_SCORE_NAME_MAX_CHARS = 32;
export const PHYSIOLOGY_EXT_ID_MAX_CHARS = 64;
export const PHYSIOLOGY_COLLECTOR_VERSION_MAX_CHARS = 32;
export const PHYSIOLOGY_MAX_VERSION = 999;
export const PHYSIOLOGY_MAX_SAMPLES = 300;
export const PHYSIOLOGY_MAX_IRREGULAR_SAMPLES = 240;
export const PHYSIOLOGY_HEART_RATE_MIN_STEP_S = 15;
export const PHYSIOLOGY_DENSE_MAX_STEP_S = 14;
export const PHYSIOLOGY_MAX_SEGMENTS = 200;
export const PHYSIOLOGY_MAX_SLEEP_SECONDS = 86_400;
export const PHYSIOLOGY_MOVEMENT_STATES = [
  "sedentary",
  "active",
  "walking",
  "running",
  "cycling",
  "other",
  "unknown"
] as const;
export const PHYSIOLOGY_SLEEP_STAGES = ["in_bed", "asleep", "awake", "light", "deep", "rem"] as const;
export const PHYSIOLOGY_MOVEMENT_BASES = ["device_label", "inferred"] as const;
export const PHYSIOLOGY_HRV_METHODS = ["rmssd", "sdnn"] as const;
export const PHYSIOLOGY_DAILY_FIELDS = [
  "steps",
  "resting_hr",
  "stress_avg",
  "active_min",
  "kcal_active",
  "floors",
  "distance_m",
  "scores"
] as const;
export const PHYSIOLOGY_COMMON_ATTRS = ["device", "route", "v", "collector_version"] as const;
export const PHYSIOLOGY_SAMPLE_ATTRS = [
  "step_s",
  "values",
  "t",
  "n",
  "min",
  "max",
  "avg",
  "coverage_s",
  "src_step_s",
  "flags",
  "tz_change",
  "unit_raw"
] as const;
export const PHYSIOLOGY_WORKOUT_ATTRS = [
  "activity_type",
  "ext_id",
  "duration_min",
  "distance_m",
  "energy_kcal",
  "avg_hr",
  "max_hr"
] as const;

const SAMPLED_UNITS: Readonly<Record<string, readonly string[] | null>> = {
  heart_rate: ["bpm"],
  heart_rate_dense: ["bpm"],
  hrv: ["ms"],
  stress: null,
  score_series: null,
  respiration: ["br/min"],
  spo2: ["%"],
  skin_temp: ["degC", "degC_delta"]
};
/** Units that count whole things, so their readings are integers. */
const COUNT_UNITS = new Set(["bpm"]);

const LABEL = /^[A-Za-z0-9._:-]+$/;
const LABEL_RULE = "letters, digits and . _ : - only (A-Z a-z 0-9, no | or spaces)";
const FLAG_CODE = /^[a-z0-9_]{1,16}$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Attrs = Record<string, unknown>;

export interface PhysiologyEventInput {
  id: string;
  kind: string;
  tsStart: Date;
  tsEnd: Date | null;
  approximate: boolean;
  attrs: Attrs;
}

const isObject = (value: unknown): value is Attrs =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const present = (attrs: Attrs, name: string) => attrs[name] !== undefined;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const decimalsOver = (value: number, places: number) => {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6;
};
const list = (values: readonly string[]) => values.join(", ");

function periodSeconds(kind: string): number | null {
  if (kind === "heart_rate_dense") return 300;
  if ((PHYSIOLOGY_SAMPLED_KINDS as readonly string[]).includes(kind) || kind === "steps" || kind === "movement")
    return 3600;
  return null;
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = LOCAL_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The key a physiology event must carry, or null when its attrs lack what the key is made of (device, v, and for some
 * kinds local_date, score_name or ext_id). `route` is never part of it, so one fact from two routes has one identity.
 */
export function canonicalPhysiologyKey(kind: string, attrs: Attrs, tsStart: Date): string | null {
  const { device, v } = attrs;
  if (typeof device !== "string" || !isInt(v) || Number.isNaN(tsStart.getTime())) return null;
  const instant = tsStart.toISOString();
  let period: string;
  if (kind === "sleep" || kind === "daily") {
    if (typeof attrs.local_date !== "string") return null;
    period = attrs.local_date;
  } else if (kind === "score") {
    if (typeof attrs.score_name !== "string") return null;
    period = `${attrs.score_name}@${typeof attrs.local_date === "string" ? attrs.local_date : instant}`;
  } else if (kind === "workout") {
    period = typeof attrs.ext_id === "string" ? `x:${attrs.ext_id}` : `${instant.slice(0, 19)}Z`;
  } else {
    period = instant;
  }
  return `${kind}|${device}|${period}|v${v}`;
}

function checkLabel(attrs: Attrs, name: string, max: number): string | null {
  const value = attrs[name];
  if (value === undefined) return `attrs.${name} is missing. Send a label of 1 to ${max} characters: ${LABEL_RULE}.`;
  if (typeof value !== "string" || value.length < 1 || value.length > max || !LABEL.test(value))
    return `attrs.${name} must be a label of 1 to ${max} characters: ${LABEL_RULE}.`;
  return null;
}

function checkCommon(attrs: Attrs): string | null {
  const device = checkLabel(attrs, "device", PHYSIOLOGY_DEVICE_MAX_CHARS);
  if (device) return device;
  const route = checkLabel(attrs, "route", PHYSIOLOGY_ROUTE_MAX_CHARS);
  if (route) return route;
  const v = attrs.v;
  if (v === undefined)
    return `attrs.v is missing. Send the version of this period as a whole number from 0 to ${PHYSIOLOGY_MAX_VERSION} (0 the first time, one more than the highest held when you re-post fuller data).`;
  if (!isInt(v) || v < 0 || v > PHYSIOLOGY_MAX_VERSION)
    return `attrs.v must be a whole number from 0 to ${PHYSIOLOGY_MAX_VERSION}.`;
  const version = attrs.collector_version;
  if (version !== undefined && (typeof version !== "string" || version.length > PHYSIOLOGY_COLLECTOR_VERSION_MAX_CHARS))
    return `attrs.collector_version must be text of at most ${PHYSIOLOGY_COLLECTOR_VERSION_MAX_CHARS} characters, or left out.`;
  return null;
}

function checkScale(value: unknown, path: string): string | null {
  if (value === undefined) return `${path} is missing. Send {"min": 0, "max": 100, "higher_means": "more stress"}.`;
  if (!isObject(value)) return `${path} must be an object like {"min": 0, "max": 100, "higher_means": "more stress"}.`;
  for (const key of Object.keys(value))
    if (!["min", "max", "higher_means"].includes(key))
      return `${path}.${key} is not allowed. A scale holds min, max and higher_means.`;
  if (!isNumber(value.min) || !isNumber(value.max)) return `${path}.min and ${path}.max must be numbers.`;
  if (value.min >= value.max) return `${path}.min must be less than ${path}.max.`;
  const meaning = value.higher_means;
  if (typeof meaning !== "string" || meaning.length < 1 || meaning.length > 64)
    return `${path}.higher_means must be text of 1 to 64 characters saying what a higher number means, such as "more stress".`;
  return null;
}

function checkLabelValue(value: unknown, path: string, max: number): string | null {
  if (value === undefined) return `${path} is missing. Send a label of 1 to ${max} characters: ${LABEL_RULE}.`;
  if (typeof value !== "string" || value.length < 1 || value.length > max || !LABEL.test(value))
    return `${path} must be a label of 1 to ${max} characters: ${LABEL_RULE}.`;
  return null;
}

function checkScores(value: unknown, path: string): string | null {
  if (!isObject(value)) return `${path} must be an object of {"<score name>": {"value": 80, "scale": {...}}}.`;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 8) return `${path} must hold 1 to 8 scores.`;
  for (const [name, entry] of entries) {
    const nameProblem = checkLabelValue(name, `${path} key "${name.slice(0, 40)}"`, PHYSIOLOGY_SCORE_NAME_MAX_CHARS);
    if (nameProblem) return nameProblem;
    if (!isObject(entry)) return `${path}.${name} must be {"value": 80, "scale": {...}}.`;
    for (const key of Object.keys(entry))
      if (key !== "value" && key !== "scale")
        return `${path}.${name}.${key} is not allowed. A score holds value and scale.`;
    const scale = checkScale(entry.scale, `${path}.${name}.scale`);
    if (scale) return scale;
    if (!isNumber(entry.value)) return `${path}.${name}.value must be a number.`;
    const { min, max } = entry.scale as { min: number; max: number };
    if (entry.value < min || entry.value > max)
      return `${path}.${name}.value ${entry.value} is outside its scale (${min} to ${max}).`;
  }
  return null;
}

function unknownAttr(kind: string, attrs: Attrs, allowed: readonly string[]): string | null {
  for (const key of Object.keys(attrs))
    if (attrs[key] !== undefined && !allowed.includes(key))
      return `attrs.${key} is not an attr of physiology kind "${kind}". Allowed: ${list(allowed)}.`;
  return null;
}

function checkSamples(kind: string, attrs: Attrs, period: number): string | null {
  const units = SAMPLED_UNITS[kind] ?? null;
  const unit = attrs.unit;
  if (units !== null) {
    if (unit === undefined) return `attrs.unit is missing. Send ${units.map((u) => `"${u}"`).join(" or ")}.`;
    if (typeof unit !== "string" || !units.includes(unit))
      return `attrs.unit ${JSON.stringify(unit)?.slice(0, 40)} is not allowed for "${kind}". Send ${units.map((u) => `"${u}"`).join(" or ")}; keep a converted original in attrs.unit_raw.`;
  }
  if (kind === "hrv") {
    const method = attrs.method;
    if (method === undefined)
      return `attrs.method is missing. Send one of: ${list(PHYSIOLOGY_HRV_METHODS)} (never mixed).`;
    if (typeof method !== "string" || !(PHYSIOLOGY_HRV_METHODS as readonly string[]).includes(method))
      return `attrs.method ${JSON.stringify(method)?.slice(0, 40)} is not allowed. Use one of: ${list(PHYSIOLOGY_HRV_METHODS)}.`;
  }
  if (kind === "stress" || kind === "score_series") {
    const scale = checkScale(attrs.scale, "attrs.scale");
    if (scale) return scale;
  }
  if (kind === "score_series") {
    const name = checkLabelValue(attrs.score_name, "attrs.score_name", PHYSIOLOGY_SCORE_NAME_MAX_CHARS);
    if (name) return name;
  }

  // Step and shape of the series.
  const step = attrs.step_s;
  if (step === undefined)
    return "attrs.step_s is missing. Send the seconds between readings, or null with attrs.t (second offsets) for irregular readings.";
  if (step !== null && (!isInt(step) || step < 1))
    return "attrs.step_s must be a whole number of seconds (1 or more), or null.";
  if (kind === "heart_rate" && step !== null && step < PHYSIOLOGY_HEART_RATE_MIN_STEP_S)
    return `attrs.step_s ${step} is below ${PHYSIOLOGY_HEART_RATE_MIN_STEP_S} for heart_rate. Send readings every 1 to ${PHYSIOLOGY_DENSE_MAX_STEP_S} seconds as kind heart_rate_dense, plus a downsampled hourly heart_rate.`;
  if (kind === "heart_rate_dense" && (step === null || step > PHYSIOLOGY_DENSE_MAX_STEP_S))
    return `attrs.step_s for heart_rate_dense must be a whole number from 1 to ${PHYSIOLOGY_DENSE_MAX_STEP_S}. Slower readings are kind heart_rate.`;
  const values = attrs.values;
  if (!Array.isArray(values)) return "attrs.values must be a list of readings (null for a gap).";
  let expected: number;
  if (step === null) {
    if (attrs.t === undefined)
      return "attrs.t is missing. With step_s null, send t: the second offset of each reading.";
    const t = attrs.t;
    if (!Array.isArray(t)) return "attrs.t must be a list of second offsets.";
    if (t.length > PHYSIOLOGY_MAX_IRREGULAR_SAMPLES)
      return `attrs.t holds ${t.length} entries; at most ${PHYSIOLOGY_MAX_IRREGULAR_SAMPLES}. Use a fixed step_s grid instead.`;
    if (t.length !== values.length)
      return `attrs.t has ${t.length} entries but attrs.values has ${values.length}; they must match.`;
    let previous = -1;
    for (const [index, offset] of t.entries()) {
      if (!isInt(offset) || offset < 0 || offset >= period)
        return `attrs.t[${index}] must be a whole number inside the period (0 to ${period - 1} seconds).`;
      if (offset <= previous) return `attrs.t[${index}] must be sorted: each offset greater than the one before.`;
      previous = offset;
    }
    expected = t.length;
  } else {
    if (attrs.t !== undefined)
      return "attrs.t is only for irregular samples (step_s null). Leave it out for a fixed step_s.";
    expected = Math.ceil(period / step);
    if (expected > PHYSIOLOGY_MAX_SAMPLES)
      return `step_s ${step} would need ${expected} values for this period; at most ${PHYSIOLOGY_MAX_SAMPLES}. Use a larger step_s${kind === "heart_rate" ? "" : ", or a downsampled series"}.`;
    if (values.length !== expected)
      return `attrs.values has ${values.length} entries; at step_s ${step} this period holds ${expected} (use null for a gap).`;
  }
  let nonNull = 0;
  const integerOnly = typeof unit === "string" && COUNT_UNITS.has(unit);
  for (const [index, reading] of values.entries()) {
    if (reading === null) continue;
    if (!isNumber(reading)) return `attrs.values[${index}] must be a number or null.`;
    nonNull += 1;
    if (integerOnly && !Number.isInteger(reading))
      return `attrs.values[${index}] ${reading}: values must be whole numbers for unit ${String(unit)}.`;
    if (decimalsOver(reading, 1))
      return `attrs.values[${index}] ${reading} has more than 1 decimal place. Round to 1 decimal place.`;
  }
  if (!isInt(attrs.n) || attrs.n < 0) return "attrs.n must be the count of non-null values (a whole number).";
  if (attrs.n !== nonNull)
    return `attrs.n is ${attrs.n} but attrs.values holds ${nonNull} non-null readings. Send n equal to the count.`;
  if (nonNull === 0) return "attrs.n is 0: the period has no readings. Do not post an empty period.";
  const { min, max, avg } = attrs;
  if (!isNumber(min) || !isNumber(max) || !isNumber(avg)) return "attrs.min, attrs.max and attrs.avg must be numbers.";
  if (decimalsOver(min, 1) || decimalsOver(max, 1)) return "attrs.min and attrs.max may have at most 1 decimal place.";
  if (decimalsOver(avg, 2)) return "attrs.avg may have at most 2 decimal places.";
  if (!(min <= avg && avg <= max))
    return `attrs.min, attrs.avg and attrs.max must satisfy min <= avg <= max (got ${min}, ${avg}, ${max}).`;
  const coverage = attrs.coverage_s;
  if (!isInt(coverage) || coverage < 0)
    return "attrs.coverage_s must be a whole number of seconds covered by readings.";
  if (coverage > period) return `attrs.coverage_s ${coverage} is more than the period (${period} seconds).`;
  if (step !== null && coverage > nonNull * step)
    return `attrs.coverage_s ${coverage} is more than n x step_s (${nonNull * step}). Send the seconds the readings really cover.`;
  const source = attrs.src_step_s;
  if (source !== undefined && source !== null && (!isInt(source) || source < 1))
    return "attrs.src_step_s must be the source's own whole-second step, or null, or left out.";
  const flags = attrs.flags;
  if (flags !== undefined) {
    if (!Array.isArray(flags))
      return "attrs.flags must be a list with one entry per value (null where the reading was fine).";
    if (flags.length !== values.length)
      return `attrs.flags has ${flags.length} entries but attrs.values has ${values.length}; they must match.`;
    for (const [index, flag] of flags.entries()) {
      if (flag === null) continue;
      if (typeof flag !== "string" || !FLAG_CODE.test(flag))
        return `attrs.flags[${index}] must be null or a code of 1 to 16 characters from a-z 0-9 _.`;
      if (values[index] !== null)
        return `attrs.flags[${index}] is "${flag}" but attrs.values[${index}] is ${String(values[index])}; a reading the source could not measure must be a null value.`;
    }
  }
  const change = attrs.tz_change;
  if (change !== undefined) {
    if (!isObject(change)) return 'attrs.tz_change must be {"at_s": 1800, "tz_offset_min": 600}.';
    for (const key of Object.keys(change))
      if (key !== "at_s" && key !== "tz_offset_min")
        return `attrs.tz_change.${key} is not allowed. Send at_s and tz_offset_min.`;
    if (!isInt(change.at_s) || change.at_s < 0 || change.at_s > period)
      return `attrs.tz_change.at_s must be a whole number of seconds inside the period (0 to ${period}).`;
    if (!isInt(change.tz_offset_min) || Math.abs(change.tz_offset_min) > 840)
      return "attrs.tz_change.tz_offset_min must be a whole number of minutes east of UTC between -840 and 840.";
  }
  const raw = attrs.unit_raw;
  if (raw !== undefined && (typeof raw !== "string" || raw.length < 1 || raw.length > 32))
    return "attrs.unit_raw must be text of 1 to 32 characters (the unit before you converted), or left out.";
  return null;
}

function checkSegments(
  attrs: Attrs,
  span: number,
  field: "state" | "stage",
  allowed: readonly string[],
  extraKeys: readonly string[]
): string | null {
  const segments = attrs.segments;
  if (segments === undefined)
    return 'attrs.segments is missing. Send [{"start_s": 0, "end_s": 600, "' + field + '": "' + allowed[0] + '"}].';
  if (!Array.isArray(segments)) return "attrs.segments must be a list of {start_s, end_s, " + field + "}.";
  if (segments.length === 0) return "attrs.segments is empty. Do not post an empty period.";
  if (segments.length > PHYSIOLOGY_MAX_SEGMENTS)
    return `attrs.segments holds ${segments.length} entries; at most ${PHYSIOLOGY_MAX_SEGMENTS}.`;
  let previousEnd = 0;
  for (const [index, segment] of segments.entries()) {
    const at = `attrs.segments[${index}]`;
    if (!isObject(segment)) return `${at} must be {"start_s": 0, "end_s": 600, "${field}": "${allowed[0]}"}.`;
    for (const key of Object.keys(segment))
      if (!["start_s", "end_s", field, ...extraKeys].includes(key))
        return `${at}.${key} is not allowed. A segment holds ${list(["start_s", "end_s", field, ...extraKeys])}.`;
    const { start_s: from, end_s: to } = segment;
    if (!isInt(from) || !isInt(to) || from < 0)
      return `${at}.start_s and ${at}.end_s must be whole seconds from the period start.`;
    if (from >= to) return `${at}.start_s ${from} must be less than ${at}.end_s ${to}.`;
    if (to > span) return `${at}.end_s ${to} is past the period (${span} seconds).`;
    if (from < previousEnd)
      return `${at} starts at ${from}, before the previous segment ends at ${previousEnd}: segments must be sorted by start_s and must not overlap.`;
    previousEnd = to;
    const label = segment[field];
    if (typeof label !== "string" || !allowed.includes(label))
      return `${at}.${field} ${JSON.stringify(label)?.slice(0, 40) ?? "is missing"} is not allowed. Use one of: ${list(allowed)}.`;
    if (field === "stage" && segment.stage_raw !== undefined) {
      const raw = segment.stage_raw;
      if (typeof raw !== "string" || raw.length < 1 || raw.length > 32)
        return `${at}.stage_raw must be text of 1 to 32 characters (the source's own stage name), or left out.`;
    }
  }
  return null;
}

function checkNonNegative(attrs: Attrs, name: string, whole: boolean, required: boolean, max = 1e9): string | null {
  const value = attrs[name];
  if (value === undefined) return required ? `attrs.${name} is missing.` : null;
  if (!isNumber(value) || value < 0 || value > max || (whole && !Number.isInteger(value)))
    return `attrs.${name} must be a ${whole ? "whole " : ""}number from 0 to ${max}.`;
  return null;
}

function checkLocalDate(attrs: Attrs, required: boolean): string | null {
  const value = attrs.local_date;
  if (value === undefined)
    return required ? "attrs.local_date is missing. Send the date exactly as the source states it, YYYY-MM-DD." : null;
  if (!validLocalDate(value))
    return `attrs.local_date ${JSON.stringify(value)?.slice(0, 20)} must be a real date as YYYY-MM-DD.`;
  return null;
}

function checkWorkout(attrs: Attrs): string | null {
  const type = attrs.activity_type;
  if (type === undefined)
    return 'attrs.activity_type is missing. Send the kind of workout as short text, such as "run".';
  if (typeof type !== "string" || type.length < 1 || type.length > 48)
    return "attrs.activity_type must be text of 1 to 48 characters.";
  if (attrs.ext_id !== undefined) {
    const id = checkLabelValue(attrs.ext_id, "attrs.ext_id", PHYSIOLOGY_EXT_ID_MAX_CHARS);
    if (id) return id;
  }
  const problem =
    checkNonNegative(attrs, "duration_min", false, false, 10_080) ??
    checkNonNegative(attrs, "distance_m", false, false) ??
    checkNonNegative(attrs, "energy_kcal", false, false) ??
    checkNonNegative(attrs, "avg_hr", true, false, 300) ??
    checkNonNegative(attrs, "max_hr", true, false, 300);
  if (problem) return problem;
  if (typeof attrs.avg_hr === "number" && typeof attrs.max_hr === "number" && attrs.max_hr < attrs.avg_hr)
    return `attrs.max_hr ${attrs.max_hr} is below attrs.avg_hr ${attrs.avg_hr}. Check the two.`;
  return null;
}

function checkCorrection(input: PhysiologyEventInput): string | null {
  const { attrs, id } = input;
  const problem = unknownAttr("correction", attrs, ["corrects", "void", "fix", "route", "collector_version"]);
  if (problem) return problem;
  const corrects = attrs.corrects;
  if (corrects === undefined) return "attrs.corrects is missing. Send the key of the row this corrects.";
  const parts = typeof corrects === "string" ? corrects.split("|") : [];
  if (
    parts.length !== 4 ||
    !(PHYSIOLOGY_KINDS as readonly string[]).includes(parts[0]!) ||
    !/^v\d{1,3}$/.test(parts[3]!)
  )
    return `attrs.corrects must be the full key of a physiology row, such as "heart_rate|band-1|2026-11-08T10:00:00.000Z|v0".`;
  const hasVoid = present(attrs, "void");
  const hasFix = present(attrs, "fix");
  if (hasVoid === hasFix)
    return "A correction needs exactly one of void or fix. Send void: true (deleted at the source) or fix (a collector bug).";
  if (hasVoid && attrs.void !== true) return "attrs.void must be true, or send fix instead.";
  if (hasFix && (!isObject(attrs.fix) || Object.keys(attrs.fix).length === 0))
    return "attrs.fix must be a non-empty object of the corrected attrs.";
  if (attrs.route !== undefined) {
    const route = checkLabel(attrs, "route", PHYSIOLOGY_ROUTE_MAX_CHARS);
    if (route) return route;
  }
  const prefix = `correction|${corrects as string}|`;
  const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  if (!/^\d{1,3}$/.test(suffix))
    return `id "${id.slice(0, 80)}" is not the canonical key; send id "${prefix}<n>" with n a whole number from 0 to 999 (the next unused).`;
  return null;
}

function keyProblem(input: PhysiologyEventInput): string | null {
  const expected = canonicalPhysiologyKey(input.kind, input.attrs, input.tsStart);
  if (expected === null || input.id === expected) return null;
  if (input.id.startsWith("h:"))
    return `the server-made id ${input.id.slice(0, 40)} is not the canonical key; send id "${expected}". A shorthand post must carry the canonical id.`;
  return `id "${input.id.slice(0, 80)}" is not the canonical key for this event; send id "${expected}". The key is <kind>|<device>|<period>|v<v>, and route is not part of it.`;
}

/**
 * Why a `physiology` event cannot be stored, in words that name the field and the fix, or null when it is a valid
 * period row. Called by `validateActivityEvent` after the generic checks (kind known, times real) and before storing.
 */
export function describePhysiologyProblem(input: PhysiologyEventInput): string | null {
  const { kind, attrs } = input;
  if (kind === "correction") return checkCorrection(input);
  const common = checkCommon(attrs);
  if (common) return common;

  const period = periodSeconds(kind);
  let allowed: readonly string[];
  if ((PHYSIOLOGY_SAMPLED_KINDS as readonly string[]).includes(kind)) {
    allowed = [
      ...PHYSIOLOGY_COMMON_ATTRS,
      ...(SAMPLED_UNITS[kind] === null ? [] : ["unit"]),
      ...(kind === "hrv" ? ["method"] : []),
      ...(kind === "stress" ? ["scale"] : []),
      ...(kind === "score_series" ? ["score_name", "scale"] : []),
      ...PHYSIOLOGY_SAMPLE_ATTRS
    ];
  } else if (kind === "steps") allowed = [...PHYSIOLOGY_COMMON_ATTRS, "steps"];
  else if (kind === "movement") allowed = [...PHYSIOLOGY_COMMON_ATTRS, "basis", "segments"];
  else if (kind === "sleep") allowed = [...PHYSIOLOGY_COMMON_ATTRS, "local_date", "segments", "scores"];
  else if (kind === "daily") allowed = [...PHYSIOLOGY_COMMON_ATTRS, "local_date", ...PHYSIOLOGY_DAILY_FIELDS];
  else if (kind === "score") allowed = [...PHYSIOLOGY_COMMON_ATTRS, "local_date", "score_name", "scale", "value"];
  else allowed = [...PHYSIOLOGY_COMMON_ATTRS, ...PHYSIOLOGY_WORKOUT_ATTRS];
  const unknown = unknownAttr(kind, attrs, allowed);
  if (unknown) return unknown;

  if (period !== null) {
    const startMs = input.tsStart.getTime();
    if (startMs % (period * 1000) !== 0) {
      const boundary = new Date(Math.floor(startMs / (period * 1000)) * period * 1000).toISOString();
      return `start ${input.tsStart.toISOString()} is not the start of a UTC ${period === 3600 ? "hour" : "5-minute slot"}. This kind covers one ${period === 3600 ? "hour" : "5-minute slot"}; use start ${boundary}.`;
    }
    if (input.tsEnd !== null && input.tsEnd.getTime() !== startMs + period * 1000)
      return `end must be the end of the period, ${new Date(startMs + period * 1000).toISOString()}, or left out.`;
  }

  let problem: string | null = null;
  if ((PHYSIOLOGY_SAMPLED_KINDS as readonly string[]).includes(kind)) problem = checkSamples(kind, attrs, period!);
  else if (kind === "steps") problem = checkNonNegative(attrs, "steps", true, true, 1_000_000);
  else if (kind === "movement") {
    const basis = attrs.basis;
    if (basis === undefined) problem = `attrs.basis is missing. Send one of: ${list(PHYSIOLOGY_MOVEMENT_BASES)}.`;
    else if (typeof basis !== "string" || !(PHYSIOLOGY_MOVEMENT_BASES as readonly string[]).includes(basis))
      problem = `attrs.basis ${JSON.stringify(basis)?.slice(0, 40)} is not allowed. Use one of: ${list(PHYSIOLOGY_MOVEMENT_BASES)}.`;
    else if (basis === "inferred" && !input.approximate)
      problem = 'attrs.basis "inferred" requires approximate: true on the event. Send approximate: true.';
    else problem = checkSegments(attrs, 3600, "state", PHYSIOLOGY_MOVEMENT_STATES, []);
  } else if (kind === "sleep") {
    problem = checkLocalDate(attrs, true);
    if (!problem && input.tsEnd === null)
      problem = "sleep needs an end: the time you woke. Send end after start (at most 24 hours later).";
    if (!problem) {
      const span = Math.round((input.tsEnd!.getTime() - input.tsStart.getTime()) / 1000);
      if (span > PHYSIOLOGY_MAX_SLEEP_SECONDS)
        problem = `sleep spans ${span} seconds; at most ${PHYSIOLOGY_MAX_SLEEP_SECONDS} (24 hours).`;
      else problem = checkSegments(attrs, span, "stage", PHYSIOLOGY_SLEEP_STAGES, ["stage_raw"]);
    }
    if (!problem && attrs.scores !== undefined) problem = checkScores(attrs.scores, "attrs.scores");
  } else if (kind === "daily") {
    problem = checkLocalDate(attrs, true);
    if (!problem) {
      const given = PHYSIOLOGY_DAILY_FIELDS.filter((name) => present(attrs, name));
      if (given.length === 0)
        problem =
          "daily carries no fields. Do not post an empty period; send at least one of: " +
          list(PHYSIOLOGY_DAILY_FIELDS) +
          ".";
    }
    problem ??=
      checkNonNegative(attrs, "steps", true, false, 1_000_000) ??
      checkNonNegative(attrs, "resting_hr", true, false, 300) ??
      checkNonNegative(attrs, "stress_avg", false, false) ??
      checkNonNegative(attrs, "active_min", false, false, 1440) ??
      checkNonNegative(attrs, "kcal_active", false, false) ??
      checkNonNegative(attrs, "floors", true, false) ??
      checkNonNegative(attrs, "distance_m", false, false) ??
      (attrs.scores === undefined ? null : checkScores(attrs.scores, "attrs.scores"));
  } else if (kind === "score") {
    problem =
      checkLabelValue(attrs.score_name, "attrs.score_name", PHYSIOLOGY_SCORE_NAME_MAX_CHARS) ??
      checkScale(attrs.scale, "attrs.scale") ??
      checkLocalDate(attrs, false);
    if (!problem) {
      const value = attrs.value;
      const scale = attrs.scale as { min: number; max: number };
      if (!isNumber(value)) problem = "attrs.value must be a number.";
      else if (value < scale.min || value > scale.max)
        problem = `attrs.value ${value} is outside the scale (${scale.min} to ${scale.max}).`;
    }
  } else problem = checkWorkout(attrs);
  if (problem) return problem;
  return keyProblem(input);
}

const labelSchema = (max: number) => ({ type: "string", minLength: 1, maxLength: max, pattern: LABEL.source });
const scaleSchema = {
  type: "object",
  required: ["min", "max", "higher_means"],
  additionalProperties: false,
  properties: {
    min: { type: "number" },
    max: { type: "number" },
    higher_means: { type: "string", minLength: 1, maxLength: 64 }
  },
  description: 'min must be less than max. higher_means is free text, such as "more stress".'
};
const segmentSchema = (field: string, allowed: readonly string[], extra: Record<string, unknown> = {}) => ({
  type: "object",
  required: ["start_s", "end_s", field],
  additionalProperties: false,
  properties: {
    start_s: { type: "integer", minimum: 0 },
    end_s: { type: "integer", minimum: 1 },
    [field]: { enum: [...allowed] },
    ...extra
  }
});
const scoresSchema = {
  type: "object",
  minProperties: 1,
  maxProperties: 8,
  propertyNames: labelSchema(PHYSIOLOGY_SCORE_NAME_MAX_CHARS),
  additionalProperties: {
    type: "object",
    required: ["value", "scale"],
    additionalProperties: false,
    properties: { value: { type: "number" }, scale: scaleSchema }
  }
};
const commonProps = {
  device: labelSchema(PHYSIOLOGY_DEVICE_MAX_CHARS),
  route: labelSchema(PHYSIOLOGY_ROUTE_MAX_CHARS),
  v: { type: "integer", minimum: 0, maximum: PHYSIOLOGY_MAX_VERSION },
  collector_version: { type: "string", maxLength: PHYSIOLOGY_COLLECTOR_VERSION_MAX_CHARS }
};
const sampleProps = {
  step_s: { type: ["integer", "null"], minimum: 1 },
  values: { type: "array", maxItems: PHYSIOLOGY_MAX_SAMPLES, items: { type: ["number", "null"] } },
  t: { type: "array", maxItems: PHYSIOLOGY_MAX_IRREGULAR_SAMPLES, items: { type: "integer", minimum: 0 } },
  n: { type: "integer", minimum: 1 },
  min: { type: "number" },
  max: { type: "number" },
  avg: { type: "number" },
  coverage_s: { type: "integer", minimum: 0 },
  src_step_s: { type: ["integer", "null"], minimum: 1 },
  flags: {
    type: "array",
    maxItems: PHYSIOLOGY_MAX_SAMPLES,
    items: { type: ["string", "null"], pattern: FLAG_CODE.source }
  },
  tz_change: {
    type: "object",
    required: ["at_s", "tz_offset_min"],
    additionalProperties: false,
    properties: {
      at_s: { type: "integer", minimum: 0, maximum: 3600 },
      tz_offset_min: { type: "integer", minimum: -840, maximum: 840 }
    }
  },
  unit_raw: { type: "string", minLength: 1, maxLength: 32 }
};

function attrsSchema(kind: string): Record<string, unknown> {
  const sampled = (PHYSIOLOGY_SAMPLED_KINDS as readonly string[]).includes(kind);
  const units = SAMPLED_UNITS[kind] ?? null;
  const properties: Record<string, unknown> = { ...commonProps };
  const required = ["device", "route", "v"];
  if (sampled) {
    Object.assign(properties, sampleProps);
    required.push("step_s", "values", "n", "min", "max", "avg", "coverage_s");
    if (units !== null) {
      properties.unit = { enum: [...units] };
      required.push("unit");
    }
    if (kind === "heart_rate")
      properties.step_s = { type: ["integer", "null"], minimum: PHYSIOLOGY_HEART_RATE_MIN_STEP_S };
    if (kind === "heart_rate_dense")
      properties.step_s = { type: "integer", minimum: 1, maximum: PHYSIOLOGY_DENSE_MAX_STEP_S };
    if (kind === "heart_rate_dense")
      properties.tz_change = {
        ...sampleProps.tz_change,
        properties: {
          at_s: { type: "integer", minimum: 0, maximum: 300 },
          tz_offset_min: sampleProps.tz_change.properties.tz_offset_min
        }
      };
    if (kind === "hrv") {
      properties.method = { enum: [...PHYSIOLOGY_HRV_METHODS] };
      required.push("method");
    }
    if (kind === "stress" || kind === "score_series") {
      properties.scale = scaleSchema;
      required.push("scale");
    }
    if (kind === "score_series") {
      properties.score_name = labelSchema(PHYSIOLOGY_SCORE_NAME_MAX_CHARS);
      required.push("score_name");
    }
  } else if (kind === "steps") {
    properties.steps = { type: "integer", minimum: 0 };
    required.push("steps");
  } else if (kind === "movement") {
    properties.basis = { enum: [...PHYSIOLOGY_MOVEMENT_BASES] };
    properties.segments = {
      type: "array",
      minItems: 1,
      maxItems: PHYSIOLOGY_MAX_SEGMENTS,
      items: segmentSchema("state", PHYSIOLOGY_MOVEMENT_STATES)
    };
    required.push("basis", "segments");
  } else if (kind === "sleep") {
    properties.local_date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    properties.segments = {
      type: "array",
      minItems: 1,
      maxItems: PHYSIOLOGY_MAX_SEGMENTS,
      items: segmentSchema("stage", PHYSIOLOGY_SLEEP_STAGES, {
        stage_raw: { type: "string", minLength: 1, maxLength: 32 }
      })
    };
    properties.scores = scoresSchema;
    required.push("local_date", "segments");
  } else if (kind === "daily") {
    properties.local_date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    properties.steps = { type: "integer", minimum: 0 };
    properties.resting_hr = { type: "integer", minimum: 0, maximum: 300 };
    properties.stress_avg = { type: "number", minimum: 0 };
    properties.active_min = { type: "number", minimum: 0, maximum: 1440 };
    properties.kcal_active = { type: "number", minimum: 0 };
    properties.floors = { type: "integer", minimum: 0 };
    properties.distance_m = { type: "number", minimum: 0 };
    properties.scores = scoresSchema;
    required.push("local_date");
  } else if (kind === "score") {
    properties.local_date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    properties.score_name = labelSchema(PHYSIOLOGY_SCORE_NAME_MAX_CHARS);
    properties.scale = scaleSchema;
    properties.value = { type: "number" };
    required.push("score_name", "scale", "value");
  } else {
    properties.activity_type = { type: "string", minLength: 1, maxLength: 48 };
    properties.ext_id = labelSchema(PHYSIOLOGY_EXT_ID_MAX_CHARS);
    properties.duration_min = { type: "number", minimum: 0 };
    properties.distance_m = { type: "number", minimum: 0 };
    properties.energy_kcal = { type: "number", minimum: 0 };
    properties.avg_hr = { type: "integer", minimum: 0, maximum: 300 };
    properties.max_hr = { type: "integer", minimum: 0, maximum: 300 };
    required.push("activity_type");
  }
  return { type: "object", required, additionalProperties: false, properties };
}

const KEY_PERIOD: Record<string, string> = {
  heart_rate: "the UTC hour start, RFC 3339 with milliseconds and Z",
  heart_rate_dense: "the UTC 5-minute slot start, RFC 3339 with milliseconds and Z",
  hrv: "the UTC hour start, RFC 3339 with milliseconds and Z",
  stress: "the UTC hour start, RFC 3339 with milliseconds and Z",
  score_series: "the UTC hour start, RFC 3339 with milliseconds and Z",
  respiration: "the UTC hour start, RFC 3339 with milliseconds and Z",
  spo2: "the UTC hour start, RFC 3339 with milliseconds and Z",
  skin_temp: "the UTC hour start, RFC 3339 with milliseconds and Z",
  steps: "the UTC hour start, RFC 3339 with milliseconds and Z",
  movement: "the UTC hour start, RFC 3339 with milliseconds and Z",
  sleep: "attrs.local_date (the date of waking, YYYY-MM-DD, as the source states it)",
  daily: "attrs.local_date (YYYY-MM-DD, as the source states it)",
  score: "<score_name>@<attrs.local_date, or the start as RFC 3339 with milliseconds and Z>",
  workout: "x:<attrs.ext_id> when the source gives one, otherwise the start to the second (RFC 3339, Z)"
};

/** The JSON Schema keyword `then`, spelled so a lint rule about promise-like objects does not mistake the schema for one. */
const THEN = ["th", "en"].join("");

/** JSON Schema's if/then for one kind: its attrs must match that kind's definition. (Built from entries because `then` is a JSON Schema keyword, not a promise.) */
const whenKind = (kind: string) =>
  Object.fromEntries([
    ["if", { properties: { kind: { const: kind } }, required: ["kind"] }],
    [THEN, { properties: { attrs: { $ref: `#/$defs/attrs/${kind}` } } }]
  ]);

/**
 * The JSON Schema published for collector authors (`platform/contracts/physiology-schema.v1.json`). Regenerate the file
 * after a change: `../../engine/service/node_modules/.bin/tsx -e "import {physiologyJsonSchema as f} from './src/activity-physiology.ts'; process.stdout.write(JSON.stringify(f(), null, 2) + '\n')" > physiology-schema.v1.json`
 * (run from `platform/contracts`; `tsx` is a dependency of `engine/service`, not of contracts. `portal/server/physiology-schema.test.ts` fails when the file is stale).
 */
export function physiologyJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openrhen.example/schemas/physiology.v1.json",
    title: "OpenRhen physiology events, version 1",
    description:
      "One event of source physiology, as an element of the events list of POST /api/activity-events (see activity-events.v1.json for the batch). Every physiology event is a period row identified by its canonical key, <kind>|<attrs.device>|<period>|v<attrs.v>; route is not part of it. This schema checks shape; the server also checks what it cannot express: the key, that start sits on the period boundary, values.length against step_s, n, min <= avg <= max, coverage_s, sorted non-overlapping segments and offsets, and flags against values. It states the fix for each rejection. Physiology rows are context for a predictor: nothing here changes what the plan allows.",
    type: "object",
    required: ["id", "source", "kind", "start", "attrs"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "The canonical key. The server states the one it expected."
      },
      source: { const: PHYSIOLOGY_SOURCE },
      kind: { enum: [...PHYSIOLOGY_KINDS, "correction"] },
      start: { type: "string", format: "date-time" },
      end: { type: ["string", "null"], format: "date-time" },
      tzOffsetMin: { type: ["integer", "null"], minimum: -840, maximum: 840 },
      approximate: {
        type: "boolean",
        description: "True for values inferred rather than measured; required for movement basis inferred."
      },
      attrs: { type: "object" }
    },
    allOf: [...PHYSIOLOGY_KINDS, "correction"].map(whenKind),
    $defs: {
      attrs: {
        ...Object.fromEntries(PHYSIOLOGY_KINDS.map((kind) => [kind, attrsSchema(kind)])),
        correction: {
          type: "object",
          required: ["corrects"],
          additionalProperties: false,
          properties: {
            corrects: { type: "string", description: "The full key of the physiology row this corrects." },
            void: { const: true },
            fix: { type: "object", minProperties: 1 },
            route: labelSchema(PHYSIOLOGY_ROUTE_MAX_CHARS),
            collector_version: commonProps.collector_version
          },
          oneOf: [{ required: ["void"] }, { required: ["fix"] }]
        }
      }
    },
    "x-schemaVersion": PHYSIOLOGY_SCHEMA_VERSION,
    "x-key": {
      form: "<kind>|<attrs.device>|<period>|v<attrs.v>",
      correction: "correction|<target key>|<n>",
      period: KEY_PERIOD
    }
  };
}
