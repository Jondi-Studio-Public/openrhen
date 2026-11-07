import { eventKey } from "../keys.js";
import { xmlStartTags } from "../xml-stream.js";
import { skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Apple Health `export.xml`, streamed (it can be several GB with millions of `Record` rows). Three kinds:
 *  - `steps`: HKQuantityTypeIdentifierStepCount records summed into hourly buckets per source device (an iPhone
 *    and a Watch each get their own rows; they are not merged here). A record counts in the local hour it starts
 *    in, using its own offset, so the bucket is a real wall-clock hour and `tzOffsetMin` is the offset.
 *  - `sleep`: HKCategoryTypeIdentifierSleepAnalysis records, one per stage, with the stage in attrs.
 *  - `workout`: `Workout` elements, with type, duration and (when the element carries them) distance and energy.
 * Dates look like `2026-01-02 03:04:05 +1100`. Heart rate and the other record types are ignored (counted).
 * Records with an unreadable date, a negative or non-numeric step value, or an unknown sleep stage are skipped
 * and counted. Step buckets are emitted when the file ends, so a bucket is never emitted twice with part of its sum.
 */
const DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

interface AppleDate {
  ms: number;
  offsetMin: number;
}

export function parseAppleDate(value: string | undefined): AppleDate | null {
  if (!value) return null;
  const match = DATE.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = match as unknown as string[];
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  if (Number(oh) > 23 || Number(om) > 59) return null;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const check = new Date(local);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d) || Number(h) > 23) return null;
  return { ms: local - offsetMin * 60_000, offsetMin };
}

const SLEEP_STAGES: Record<string, string> = {
  HKCategoryValueSleepAnalysisInBed: "in_bed",
  HKCategoryValueSleepAnalysisAsleep: "asleep",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAwake: "awake"
};

const TO_MINUTES: Record<string, number> = { min: 1, sec: 1 / 60, s: 1 / 60, hr: 60, h: 60 };
const HOUR = 3_600_000;

interface Bucket {
  startMs: number;
  offsetMin: number;
  sourceName: string;
  steps: number;
  records: number;
}

const cleanName = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 100);

export async function* parseAppleHealth(source: ByteSource, stats: Stats): AsyncGenerator<ActivityEventDraft> {
  const buckets = new Map<string, Bucket>();
  for await (const tag of xmlStartTags(source, (end) => {
    if (end.truncated) stats.truncated = true;
  })) {
    if (tag.name === "Record") {
      const type = tag.attrs.type;
      if (type === "HKQuantityTypeIdentifierStepCount") {
        stats.read += 1;
        const start = parseAppleDate(tag.attrs.startDate);
        const value = Number(tag.attrs.value);
        if (!start) {
          skip(stats, "step record has an unreadable startDate");
          continue;
        }
        if (!Number.isFinite(value) || value < 0 || tag.attrs.value === "" || tag.attrs.value === undefined) {
          skip(stats, "step record has a missing or negative value");
          continue;
        }
        const sourceName = cleanName(tag.attrs.sourceName);
        if (!sourceName) {
          skip(stats, "step record has no sourceName");
          continue;
        }
        // The local wall-clock hour: shift to local, floor to the hour, shift back.
        const localMs = start.ms + start.offsetMin * 60_000;
        const bucketStart = Math.floor(localMs / HOUR) * HOUR - start.offsetMin * 60_000;
        const key = `${sourceName}\u001f${bucketStart}`;
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.steps += value;
          bucket.records += 1;
        } else
          buckets.set(key, { startMs: bucketStart, offsetMin: start.offsetMin, sourceName, steps: value, records: 1 });
      } else if (type === "HKCategoryTypeIdentifierSleepAnalysis") {
        stats.read += 1;
        const start = parseAppleDate(tag.attrs.startDate);
        const end = parseAppleDate(tag.attrs.endDate);
        const stage = SLEEP_STAGES[tag.attrs.value ?? ""];
        if (!start || !end || end.ms < start.ms) {
          skip(stats, "sleep record has an unreadable or reversed startDate and endDate");
          continue;
        }
        if (!stage) {
          skip(stats, "sleep record has a stage this importer does not know");
          continue;
        }
        const sourceName = cleanName(tag.attrs.sourceName);
        if (!sourceName) {
          skip(stats, "sleep record has no sourceName");
          continue;
        }
        stats.emitted += 1;
        yield {
          id: eventKey("apple-health", "sleep", sourceName, start.ms, end.ms, tag.attrs.value ?? ""),
          source: "apple-health",
          kind: "sleep",
          start: new Date(start.ms).toISOString(),
          end: new Date(end.ms).toISOString(),
          tzOffsetMin: start.offsetMin,
          attrs: { stage, source_name: sourceName }
        };
      } else stats.ignored += 1;
    } else if (tag.name === "Workout") {
      stats.read += 1;
      const start = parseAppleDate(tag.attrs.startDate);
      const end = parseAppleDate(tag.attrs.endDate);
      const activity = (tag.attrs.workoutActivityType ?? "").replace(/^HKWorkoutActivityType/, "");
      if (!start || !end || end.ms < start.ms) {
        skip(stats, "workout has an unreadable or reversed startDate and endDate");
        continue;
      }
      if (!/^[A-Za-z0-9]{1,60}$/.test(activity)) {
        skip(stats, "workout has no workoutActivityType");
        continue;
      }
      const sourceName = cleanName(tag.attrs.sourceName);
      const attrs: Record<string, unknown> = { activity_type: activity };
      if (sourceName) attrs.source_name = sourceName;
      const factor = TO_MINUTES[(tag.attrs.durationUnit ?? "").toLowerCase()];
      const duration = Number(tag.attrs.duration);
      if (factor !== undefined && tag.attrs.duration && Number.isFinite(duration) && duration >= 0)
        attrs.duration_min = Math.round(duration * factor * 100) / 100;
      const distance = Number(tag.attrs.totalDistance);
      if (tag.attrs.totalDistance && Number.isFinite(distance) && distance >= 0 && tag.attrs.totalDistanceUnit) {
        attrs.distance = distance;
        attrs.distance_unit = tag.attrs.totalDistanceUnit;
      }
      const energy = Number(tag.attrs.totalEnergyBurned);
      if (tag.attrs.totalEnergyBurned && Number.isFinite(energy) && energy >= 0 && tag.attrs.totalEnergyBurnedUnit) {
        attrs.energy = energy;
        attrs.energy_unit = tag.attrs.totalEnergyBurnedUnit;
      }
      stats.emitted += 1;
      yield {
        id: eventKey("apple-health", "workout", sourceName, start.ms, end.ms, activity),
        source: "apple-health",
        kind: "workout",
        start: new Date(start.ms).toISOString(),
        end: new Date(end.ms).toISOString(),
        tzOffsetMin: start.offsetMin,
        attrs
      };
    }
  }
  // A cut-off file's last bucket per device may be missing records, and its key would then be held for good with
  // a low count, so those are left out; the next full export adds them.
  if (stats.truncated) {
    const last = new Map<string, number>();
    for (const bucket of buckets.values())
      last.set(bucket.sourceName, Math.max(last.get(bucket.sourceName) ?? 0, bucket.startMs));
    for (const [key, bucket] of buckets)
      if (last.get(bucket.sourceName) === bucket.startMs) {
        buckets.delete(key);
        stats.ignored += 1;
      }
  }
  for (const bucket of [...buckets.values()].sort(
    (a, b) => a.startMs - b.startMs || a.sourceName.localeCompare(b.sourceName)
  )) {
    const start = new Date(bucket.startMs).toISOString();
    stats.emitted += 1;
    yield {
      id: eventKey("apple-health", "steps", bucket.sourceName, start),
      source: "apple-health",
      kind: "steps",
      start,
      end: new Date(bucket.startMs + HOUR).toISOString(),
      tzOffsetMin: bucket.offsetMin,
      attrs: { steps: Math.round(bucket.steps), source_name: bucket.sourceName, records: bucket.records }
    };
  }
}
