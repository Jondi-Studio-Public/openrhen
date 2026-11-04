import { fastestEstimatedLeg, type Coordinates } from "./travel-distance.js";
import type { TransportMode } from "./context-model.js";

// Journey store lookup. Kept free of zod: the matcher
// that calls it is bundled into the browser.

export interface JourneyStats {
  count: number;
  median: number;
  p80: number;
  p95: number;
}

/** One row of the SQL journey summary. `dayType` and `band` both null: the pair at any time. */
export interface JourneyCell {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  dayType: "weekday" | "weekend" | null;
  band: number | null;
  /** Google samples plus own trips that are not outliers. */
  pooled: JourneyStats;
  /** Own trips that are not outliers. */
  own: JourneyStats;
}

/** The most recent Google sample per pair × mode. */
export interface JourneyLatest {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  minutes: number;
  departedAt: string;
  observedAt: string;
}

/** The plan-forecast request's journey summary. */
export interface JourneySummary {
  cells: JourneyCell[];
  latest: JourneyLatest[];
}

export type JourneySource = "live" | "own" | "typical" | "fallback" | "assumed" | "estimated";

export interface Journey {
  /** Allowing: the planned figure. */
  minutes: number;
  typicalMinutes: number;
  mode: TransportMode;
  source: JourneySource;
  sampleCount: number;
}

export type JourneyCaution = "normal" | "high";

/** Minutes in one departure band. */
export const JOURNEY_BAND_MINUTES = 30;
/** Google lookup elements per local day. */
export const TRAVEL_LOOKUP_DAILY_LIMIT = 100;
/** A live Google sample stops counting as "live" once it is this many minutes old. */
export const JOURNEY_LIVE_MAX_AGE_MINUTES = 30;
/** A tier is used only once it has at least this many samples (own or pooled). */
export const JOURNEY_TIER_MIN_SAMPLES = 3;
/** Own trips take over from pooled once they reach this count. */
export const JOURNEY_OWN_MIN_SAMPLES = 3;
/** Padding shrinks to nothing by this many samples. */
export const JOURNEY_PADDING_SHRINK_SAMPLES = 10;
/** Padding floor, in minutes, however short the typical figure is. */
export const JOURNEY_PADDING_FLOOR_MINUTES = 3;
/** Padding ceiling, as a fraction of the typical figure. */
export const JOURNEY_PADDING_RATIO = 0.15;

/** A place as the lookup needs it: identity, an optional stored fallback, and optional coordinates. */
export interface LocationRef {
  id: string;
  /** The location's stored fallback minutes (`condition_definitions.travel_minutes`). */
  storedMinutes?: number;
  latitude?: number;
  longitude?: number;
}

const MINUTE = 60_000;

function cellKey(
  fromLocationId: string,
  toLocationId: string,
  mode: TransportMode,
  dayType: "weekday" | "weekend" | null,
  band: number | null
): string {
  return `${fromLocationId}\u0000${toLocationId}\u0000${mode}\u0000${dayType ?? "*"}\u0000${band ?? "*"}`;
}

function latestKey(fromLocationId: string, toLocationId: string, mode: TransportMode): string {
  return `${fromLocationId}\u0000${toLocationId}\u0000${mode}`;
}

/** A per-cell and per-latest lookup over one request's journey summary, built once per run. */
export interface JourneyIndex {
  cell(
    fromLocationId: string,
    toLocationId: string,
    mode: TransportMode,
    dayType: "weekday" | "weekend" | null,
    band: number | null
  ): JourneyCell | undefined;
  latest(fromLocationId: string, toLocationId: string, mode: TransportMode): JourneyLatest | undefined;
}

/** Builds the one lookup a run's `resolveJourney`/`resolveMode` calls read from. */
export function buildJourneyIndex(summary: JourneySummary): JourneyIndex {
  const cells = new Map<string, JourneyCell>();
  for (const cell of summary.cells) {
    cells.set(cellKey(cell.fromLocationId, cell.toLocationId, cell.mode, cell.dayType, cell.band), cell);
  }
  const latest = new Map<string, JourneyLatest>();
  for (const sample of summary.latest) {
    latest.set(latestKey(sample.fromLocationId, sample.toLocationId, sample.mode), sample);
  }
  return {
    cell: (fromLocationId, toLocationId, mode, dayType, band) =>
      cells.get(cellKey(fromLocationId, toLocationId, mode, dayType, band)),
    latest: (fromLocationId, toLocationId, mode) => latest.get(latestKey(fromLocationId, toLocationId, mode))
  };
}

/** The empty index: every lookup answers undefined. Used whenever a request carries no summary. */
export const EMPTY_JOURNEY_INDEX: JourneyIndex = buildJourneyIndex({ cells: [], latest: [] });

/**
 * One formatter per zone, built on first use. Construction resolves the locale and loads the zone's
 * rules, and a travel-aware plan asks for a band once per journey it weighs, so building a fresh one
 * each time was a sixth of the plan. A formatter is immutable, so sharing one changes nothing
 * it formats; an unknown zone still throws on first use and is not cached.
 */
const bandFormats = new Map<string, Intl.DateTimeFormat>();
function bandFormat(timeZone: string): Intl.DateTimeFormat {
  let format = bandFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short"
    });
    bandFormats.set(timeZone, format);
  }
  return format;
}

/**
 * The departure band a moment falls in, derived rather than stored so a timezone or band-width
 * change never needs a backfill (the travel time model design note, "Store (T1)").
 */
export function journeyBand(departAt: Date, timeZone: string): { dayType: "weekday" | "weekend"; band: number } {
  const parts = Object.fromEntries(
    bandFormat(timeZone)
      .formatToParts(departAt)
      .map((part) => [part.type, part.value])
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  const dayType: "weekday" | "weekend" = parts.weekday === "Sat" || parts.weekday === "Sun" ? "weekend" : "weekday";
  const band = Math.floor((hour * 60 + minute) / JOURNEY_BAND_MINUTES);
  return { dayType, band };
}

/** Which side of a cell to read: own once it has enough trips of its own, else pooled. */
function tier(cell: JourneyCell | undefined): { stats: JourneyStats; count: number } | undefined {
  if (!cell) return undefined;
  const stats = cell.own.count >= JOURNEY_OWN_MIN_SAMPLES ? cell.own : cell.pooled;
  return { stats, count: stats.count };
}

function tierSource(cell: JourneyCell): JourneySource {
  return cell.own.count >= JOURNEY_OWN_MIN_SAMPLES ? "own" : "typical";
}

/** `max(3, 0.15 × typical) × max(0, 1 − n/10)`, the padding that shrinks to nothing by n = 10. */
function padding(typicalMinutes: number, sampleCount: number): number {
  const floor = Math.max(JOURNEY_PADDING_FLOOR_MINUTES, JOURNEY_PADDING_RATIO * typicalMinutes);
  const shrink = Math.max(0, 1 - sampleCount / JOURNEY_PADDING_SHRINK_SAMPLES);
  return floor * shrink;
}

function percentileOf(stats: JourneyStats, caution: JourneyCaution): number {
  return caution === "high" ? stats.p95 : stats.p80;
}

/** Typical plus padding, and the larger of that and the tier's caution percentile, rounded up. */
function allowingFromTier(typicalMinutes: number, stats: JourneyStats | undefined, caution: JourneyCaution): number {
  const count = stats?.count ?? 0;
  const paddedTypical = typicalMinutes + padding(typicalMinutes, count);
  const percentile = stats ? percentileOf(stats, caution) : undefined;
  return Math.ceil(percentile !== undefined ? Math.max(percentile, paddedTypical) : paddedTypical);
}

/** The best same-pair-mode cell to lean on for spread, preferring the band cell over the any-time one. */
function bestCellFor(
  journeys: JourneyIndex,
  from: string,
  to: string,
  mode: TransportMode,
  dayType: "weekday" | "weekend",
  band: number
): JourneyCell | undefined {
  return journeys.cell(from, to, mode, dayType, band) ?? journeys.cell(from, to, mode, null, null);
}

/**
 * One journey's figures, by the plan's exact tier order: live → same pair/band/day-type (≥3) → same
 * pair any time (≥1) → the destination's stored minutes (or the way there, reversed, for the way
 * home) → straight line. Returns undefined only when nothing at all is known — no live reading, no
 * samples, no stored minutes, no coordinates.
 */
export function resolveJourney(input: {
  journeys: JourneyIndex;
  from: LocationRef;
  to: LocationRef;
  mode: TransportMode;
  departAt: Date;
  now: Date;
  timeZone: string;
  caution: JourneyCaution;
  homeLocationId?: string;
}): Journey | undefined {
  const { journeys, from, to, mode, departAt, now, timeZone, caution } = input;
  const { dayType, band } = journeyBand(departAt, timeZone);

  // Tier 1: live. A Google sample for this exact pair and mode, observed under 30 minutes ago.
  const latest = journeys.latest(from.id, to.id, mode);
  if (latest) {
    const ageMinutes = (now.getTime() - new Date(latest.observedAt).getTime()) / MINUTE;
    if (ageMinutes >= 0 && ageMinutes < JOURNEY_LIVE_MAX_AGE_MINUTES) {
      const cell = bestCellFor(journeys, from.id, to.id, mode, dayType, band);
      const spreadStats = tier(cell);
      const spreadFromCell =
        spreadStats && spreadStats.stats.median !== undefined
          ? percentileOf(spreadStats.stats, caution) - spreadStats.stats.median
          : 0;
      const spread = Math.max(spreadFromCell, padding(latest.minutes, spreadStats?.count ?? 0));
      return {
        minutes: Math.ceil(latest.minutes + spread),
        typicalMinutes: latest.minutes,
        mode,
        source: "live",
        sampleCount: spreadStats?.count ?? 0
      };
    }
  }

  // Tier 2: same pair, band and day type, with at least 3 samples (own or pooled).
  const bandCell = journeys.cell(from.id, to.id, mode, dayType, band);
  const bandTier = tier(bandCell);
  if (bandCell && bandTier && bandTier.count >= JOURNEY_TIER_MIN_SAMPLES) {
    return {
      minutes: allowingFromTier(bandTier.stats.median, bandTier.stats, caution),
      typicalMinutes: bandTier.stats.median,
      mode,
      source: tierSource(bandCell),
      sampleCount: bandTier.count
    };
  }

  // Tier 3: same pair, any time, with at least 1 sample.
  const anyCell = journeys.cell(from.id, to.id, mode, null, null);
  const anyTier = tier(anyCell);
  if (anyCell && anyTier && anyTier.count >= 1) {
    return {
      minutes: allowingFromTier(anyTier.stats.median, anyTier.stats, caution),
      typicalMinutes: anyTier.stats.median,
      mode,
      source: tierSource(anyCell),
      sampleCount: anyTier.count
    };
  }

  // Tier 4: the destination's stored minutes.
  if (to.storedMinutes !== undefined) {
    return {
      minutes: allowingFromTier(to.storedMinutes, undefined, caution),
      typicalMinutes: to.storedMinutes,
      mode,
      source: "fallback",
      sampleCount: 0
    };
  }
  // Tier 4b: the way there stands in for the way home — heading home, with no data of its own, the
  // origin's own stored figure (conventionally measured from home to it) is read back reversed.
  if (input.homeLocationId !== undefined && to.id === input.homeLocationId && from.storedMinutes !== undefined) {
    return {
      minutes: allowingFromTier(from.storedMinutes, undefined, caution),
      typicalMinutes: from.storedMinutes,
      mode,
      source: "assumed",
      sampleCount: 0
    };
  }

  // Tier 5: straight line, the last resort between two places nobody has measured.
  if (
    from.latitude !== undefined &&
    from.longitude !== undefined &&
    to.latitude !== undefined &&
    to.longitude !== undefined
  ) {
    const fromPoint: Coordinates = { latitude: from.latitude, longitude: from.longitude };
    const toPoint: Coordinates = { latitude: to.latitude, longitude: to.longitude };
    const estimate = fastestEstimatedLeg(fromPoint, toPoint, [mode]);
    if (estimate) {
      return {
        minutes: allowingFromTier(estimate.minutes, undefined, caution),
        typicalMinutes: estimate.minutes,
        mode,
        source: "estimated",
        sampleCount: 0
      };
    }
  }

  return undefined;
}

/** The typical minutes `resolveMode` compares across modes: whatever tier has data, else undefined. */
function typicalMinutesFor(
  journeys: JourneyIndex,
  from: LocationRef,
  to: LocationRef,
  mode: TransportMode
): number | undefined {
  const anyCell = journeys.cell(from.id, to.id, mode, null, null);
  const anyTier = tier(anyCell);
  if (anyTier && anyTier.count >= 1) return anyTier.stats.median;
  return to.storedMinutes;
}

/**
 * The mode order: the commitment's own mode, then
 * the place's usual mode, then the user's default, then the fastest available by typical minutes. A
 * named mode not in `transportModes` is skipped at every step.
 */
export function resolveMode(input: {
  commitmentMode?: TransportMode;
  placeUsualMode?: TransportMode;
  userDefaultMode?: TransportMode;
  transportModes: readonly TransportMode[];
  journeys: JourneyIndex;
  from: LocationRef;
  to: LocationRef;
}): TransportMode | undefined {
  const allowed = new Set(input.transportModes);
  for (const candidate of [input.commitmentMode, input.placeUsualMode, input.userDefaultMode]) {
    if (candidate !== undefined && allowed.has(candidate)) return candidate;
  }
  if (!input.transportModes.length) return undefined;
  let best: { mode: TransportMode; minutes: number } | undefined;
  for (const mode of input.transportModes) {
    const minutes = typicalMinutesFor(input.journeys, input.from, input.to, mode);
    if (minutes === undefined) continue;
    if (!best || minutes < best.minutes) best = { mode, minutes };
  }
  if (best) return best.mode;
  if (
    input.from.latitude !== undefined &&
    input.from.longitude !== undefined &&
    input.to.latitude !== undefined &&
    input.to.longitude !== undefined
  ) {
    const estimate = fastestEstimatedLeg(
      { latitude: input.from.latitude, longitude: input.from.longitude },
      { latitude: input.to.latitude, longitude: input.to.longitude },
      input.transportModes
    );
    if (estimate) return estimate.mode;
  }
  // Nothing to compare by at all: the first mode still available, so a leg is never left modeless.
  return input.transportModes[0];
}
