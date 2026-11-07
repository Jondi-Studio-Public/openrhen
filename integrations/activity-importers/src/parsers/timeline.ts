import { eventKey, DupCounter } from "../keys.js";
import { jsonArrayObjects } from "../json-stream.js";
import { fromEpochMillis, parseTimestamp, plausible } from "../time.js";
import { noRowsError, skip, type ActivityEventDraft, type ByteSource, type Stats } from "../types.js";

/**
 * Google Takeout "Timeline" (location history), UNVERIFIED against a real export. One parser reads every shape,
 * element by element, from the first array of the document:
 *  - `Records.json` `{"locations": [{timestampMs | timestamp, latitudeE7, longitudeE7, accuracy, source}]}`: a raw `point`.
 *  - `Semantic Location History/<year>/<year>_<MONTH>.json` `{"timelineObjects": [{placeVisit} | {activitySegment}]}`:
 *    a `place_visit` (start and end, position, place id) or an `activity_segment` (start and end, both positions,
 *    type, distance).
 *  - on-device `Timeline.json`, `{"semanticSegments": [...]}` or a bare array of `{startTime, endTime, visit |
 *    activity | timelinePath}`: the same kinds; each `timelinePath` point becomes a `point`.
 * Place name and address are content; positions are rounded to 5 decimals in attrs. A time needs an explicit zone
 * (ISO text) or is epoch milliseconds; a number of any other size is skipped, not rescaled. An element that matches
 * no shape is skipped and counted.
 */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const ENUM = /^[A-Za-z][A-Za-z0-9_ -]{0,39}$/;
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

interface When {
  date: Date;
  offsetMin: number | null;
}

function whenOf(iso: unknown, millis: unknown, now: Date): When | null {
  if (iso !== undefined && iso !== null) {
    const parsed = parseTimestamp(iso, { utcOffsetIsUnknown: true });
    return parsed && plausible(parsed.date, now) ? { date: parsed.date, offsetMin: parsed.offsetMin } : null;
  }
  const date = fromEpochMillis(millis, now);
  return date ? { date, offsetMin: null } : null;
}

interface Position {
  lat: number;
  lng: number;
}

function validPosition(lat: number, lng: number): Position | null {
  // 0,0 is how Takeout writes "no position".
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function fromE7(lat: unknown, lng: unknown): Position | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return validPosition(lat / 1e7, lng / 1e7);
}

/** `"-33.86°, 151.21°"` as the on-device export writes a position. */
function fromLatLngText(value: unknown): Position | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*$/.exec(value);
  return match ? validPosition(Number(match[1]), Number(match[2])) : null;
}

const posText = (p: Position | null) => (p ? `${round5(p.lat)},${round5(p.lng)}` : "");

function withTime(draft: ActivityEventDraft, when: When): ActivityEventDraft {
  if (when.offsetMin !== null) draft.tzOffsetMin = when.offsetMin;
  return draft;
}

function textOf(...values: unknown[]): string {
  return values
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.replace(/\s+/g, " ").trim())
    .join("\n");
}

function enumOf(value: unknown): string | undefined {
  return typeof value === "string" && ENUM.test(value) ? value : undefined;
}

export async function* parseTimeline(
  source: ByteSource,
  stats: Stats,
  now: Date = new Date()
): AsyncGenerator<ActivityEventDraft> {
  const dups = new DupCounter();

  const interval = (startWhen: When | null, endWhen: When | null, what: string): { start: When; end?: When } | null => {
    if (!startWhen) {
      skip(stats, `${what} has no start time with a time zone (or epoch milliseconds)`);
      return null;
    }
    if (endWhen && endWhen.date.getTime() < startWhen.date.getTime()) {
      skip(stats, `${what} ends before it starts`);
      return null;
    }
    return endWhen ? { start: startWhen, end: endWhen } : { start: startWhen };
  };

  const visit = (when: { start: When; end?: When }, v: Obj): ActivityEventDraft | null => {
    const location = isObj(v.location) ? v.location : {};
    const candidate = isObj(v.topCandidate) ? v.topCandidate : {};
    const position =
      fromE7(location.latitudeE7, location.longitudeE7) ??
      fromLatLngText(isObj(candidate.placeLocation) ? candidate.placeLocation.latLng : undefined);
    const placeId =
      typeof (location.placeId ?? candidate.placeId) === "string" ? String(location.placeId ?? candidate.placeId) : "";
    if (!position && !placeId) {
      skip(stats, "place visit has neither a position nor a place id");
      return null;
    }
    const attrs: Record<string, unknown> = {};
    if (position) {
      attrs.lat = round5(position.lat);
      attrs.lng = round5(position.lng);
    }
    if (placeId && placeId.length <= 200) attrs.place_id = placeId;
    const semantic = enumOf(location.semanticType ?? candidate.semanticType);
    if (semantic) attrs.semantic_type = semantic;
    const placeConfidence = enumOf(v.placeConfidence);
    if (placeConfidence) attrs.place_confidence = placeConfidence;
    if (typeof v.visitConfidence === "number") attrs.visit_confidence = v.visitConfidence;
    const probability = v.probability ?? candidate.probability;
    if (typeof probability === "number") attrs.probability = probability;
    const startIso = when.start.date.toISOString();
    const endIso = when.end?.date.toISOString() ?? "";
    const dup = dups.next(`v\u001f${startIso}\u001f${endIso}\u001f${placeId}\u001f${posText(position)}`);
    if (dup > 0) attrs.dup_index = dup;
    stats.emitted += 1;
    const content = textOf(location.name, location.address);
    return withTime(
      {
        id: eventKey("timeline", "place_visit", startIso, endIso, placeId, posText(position), dup),
        source: "timeline",
        kind: "place_visit",
        start: startIso,
        ...(when.end ? { end: endIso } : {}),
        attrs,
        ...(content ? { content } : {})
      },
      when.start
    );
  };

  const segment = (
    when: { start: When; end?: When },
    from: Position | null,
    to: Position | null,
    type: unknown,
    distance: unknown,
    confidence: unknown
  ): ActivityEventDraft => {
    const attrs: Record<string, unknown> = {};
    const kind = enumOf(type);
    if (kind) attrs.activity_type = kind;
    if (from) {
      attrs.start_lat = round5(from.lat);
      attrs.start_lng = round5(from.lng);
    }
    if (to) {
      attrs.end_lat = round5(to.lat);
      attrs.end_lng = round5(to.lng);
    }
    const meters = typeof distance === "string" && /^\d+(\.\d+)?$/.test(distance) ? Number(distance) : distance;
    if (typeof meters === "number" && Number.isFinite(meters) && meters >= 0) attrs.distance_m = Math.round(meters);
    if (typeof confidence === "number") attrs.confidence = confidence;
    else if (enumOf(confidence)) attrs.confidence = confidence;
    const startIso = when.start.date.toISOString();
    const endIso = when.end?.date.toISOString() ?? "";
    const dup = dups.next(
      `a\u001f${startIso}\u001f${endIso}\u001f${kind ?? ""}\u001f${posText(from)}\u001f${posText(to)}`
    );
    if (dup > 0) attrs.dup_index = dup;
    stats.emitted += 1;
    return withTime(
      {
        id: eventKey("timeline", "activity_segment", startIso, endIso, kind ?? "", posText(from), posText(to), dup),
        source: "timeline",
        kind: "activity_segment",
        start: startIso,
        ...(when.end ? { end: endIso } : {}),
        attrs
      },
      when.start
    );
  };

  const point = (at: When, position: Position, extra: { accuracy?: unknown; source?: unknown }): ActivityEventDraft => {
    const attrs: Record<string, unknown> = { lat: round5(position.lat), lng: round5(position.lng) };
    if (typeof extra.accuracy === "number" && extra.accuracy >= 0) attrs.accuracy_m = extra.accuracy;
    const origin = enumOf(extra.source);
    if (origin) attrs.source = origin;
    const iso = at.date.toISOString();
    const dup = dups.next(`p\u001f${iso}\u001f${posText(position)}`);
    if (dup > 0) attrs.dup_index = dup;
    stats.emitted += 1;
    return withTime(
      {
        id: eventKey("timeline", "point", iso, posText(position), dup),
        source: "timeline",
        kind: "point",
        start: iso,
        attrs
      },
      at
    );
  };

  for await (const element of jsonArrayObjects(source, (end) => {
    if (end.truncated) stats.truncated = true;
    if (!end.sawArray)
      throw noRowsError(
        "Timeline",
        end.topKeys,
        'a "locations", "timelineObjects" or "semanticSegments" list at the top of the file (or a top-level list)'
      );
  })) {
    const row = element.ok && isObj(element.value) ? element.value : null;
    if (!row) {
      stats.read += 1;
      skip(stats, "row is not valid JSON");
      continue;
    }

    if (isObj(row.placeVisit)) {
      stats.read += 1;
      const v = row.placeVisit;
      const d = isObj(v.duration) ? v.duration : {};
      const when = interval(
        whenOf(d.startTimestamp, d.startTimestampMs, now),
        d.endTimestamp !== undefined || d.endTimestampMs !== undefined
          ? whenOf(d.endTimestamp, d.endTimestampMs, now)
          : null,
        "place visit"
      );
      const draft = when ? visit(when, v) : null;
      if (draft) yield draft;
    } else if (isObj(row.activitySegment)) {
      stats.read += 1;
      const a = row.activitySegment;
      const d = isObj(a.duration) ? a.duration : {};
      const s = isObj(a.startLocation) ? a.startLocation : {};
      const e = isObj(a.endLocation) ? a.endLocation : {};
      const when = interval(
        whenOf(d.startTimestamp, d.startTimestampMs, now),
        d.endTimestamp !== undefined || d.endTimestampMs !== undefined
          ? whenOf(d.endTimestamp, d.endTimestampMs, now)
          : null,
        "activity segment"
      );
      if (when)
        yield segment(
          when,
          fromE7(s.latitudeE7, s.longitudeE7),
          fromE7(e.latitudeE7, e.longitudeE7),
          a.activityType,
          a.distance,
          a.confidence
        );
    } else if (isObj(row.visit) && row.startTime !== undefined) {
      stats.read += 1;
      const when = interval(
        whenOf(row.startTime, undefined, now),
        row.endTime !== undefined ? whenOf(row.endTime, undefined, now) : null,
        "place visit"
      );
      const draft = when ? visit(when, row.visit) : null;
      if (draft) yield draft;
    } else if (isObj(row.activity) && row.startTime !== undefined) {
      stats.read += 1;
      const a = row.activity;
      const candidate = isObj(a.topCandidate) ? a.topCandidate : {};
      const when = interval(
        whenOf(row.startTime, undefined, now),
        row.endTime !== undefined ? whenOf(row.endTime, undefined, now) : null,
        "activity segment"
      );
      if (when)
        yield segment(
          when,
          fromLatLngText(isObj(a.start) ? a.start.latLng : undefined),
          fromLatLngText(isObj(a.end) ? a.end.latLng : undefined),
          candidate.type,
          a.distanceMeters,
          a.probability ?? candidate.probability
        );
    } else if (Array.isArray(row.timelinePath)) {
      const base = whenOf(row.startTime, undefined, now);
      for (const item of row.timelinePath as unknown[]) {
        stats.read += 1;
        const p = isObj(item) ? item : null;
        const position = fromLatLngText(p?.point);
        if (!p || !position) {
          skip(stats, "path point has no readable position");
          continue;
        }
        let at: When | null = null;
        if (p.time !== undefined) at = whenOf(p.time, undefined, now);
        else if (
          base &&
          typeof p.durationMinutesOffsetFromStartTime === "string" &&
          /^\d{1,6}$/.test(p.durationMinutesOffsetFromStartTime)
        ) {
          const date = new Date(base.date.getTime() + Number(p.durationMinutesOffsetFromStartTime) * 60_000);
          at = plausible(date, now) ? { date, offsetMin: base.offsetMin } : null;
        }
        if (!at) {
          skip(stats, "path point has no time with a time zone");
          continue;
        }
        yield point(at, position, {});
      }
    } else if (row.latitudeE7 !== undefined || row.longitudeE7 !== undefined) {
      stats.read += 1;
      const position = fromE7(row.latitudeE7, row.longitudeE7);
      if (!position) {
        skip(stats, "location point has no usable position");
        continue;
      }
      const at = whenOf(row.timestamp, row.timestampMs, now);
      if (!at) {
        skip(stats, "location point has no time (epoch milliseconds, or text with a time zone)");
        continue;
      }
      yield point(at, position, { accuracy: row.accuracy, source: row.source });
    } else {
      stats.read += 1;
      skip(stats, "element is not a place visit, activity segment, path or location point");
    }
  }
}
