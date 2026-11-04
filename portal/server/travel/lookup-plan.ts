import {
  JOURNEY_BAND_MINUTES,
  TRAVEL_LOOKUP_DAILY_LIMIT,
  addLocalDays,
  buildJourneyIndex,
  journeyBand,
  type CommitmentTimelineWire,
  type DayPlan,
  type JourneySummary,
  type TransportMode
} from "@openrhen/contracts";
import { localDayIn } from "@/server/persistence/postgres/cadence-completion";
import { TRAVEL_LOOKUP_RESERVE, TRAVEL_LOOKUP_RESERVE_HOUR } from "@/server/travel/travel-spend";

/**
 * The pure planner behind the travel lookup tick (the travel time model design note, "Spending the
 * budget (T5)"): given the day's plan and the journey store's own summary, it decides which Google
 * lookups to spend on next, in the plan's fixed priority order, without touching a database or the
 * network itself — the tick route reads what this needs and spends what this returns through the one
 * spender. Kept free of side effects so every rule (the live windows, the reserve, the top-up order)
 * can be tested against a clock and a summary alone.
 */

export type TravelLookupStep = "next_leg_live" | "today" | "tomorrow_first" | "top_up";

/** One leg the planner wants a Google figure for. */
export interface TravelLookupLeg {
  step: TravelLookupStep;
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  /** The departure to ask Google's traffic-aware routing for. */
  departureAt: Date;
  /** Only the live pre-departure check may spend into the reserve (`travel-spend.ts`). */
  allowReserve: boolean;
}

/** Legs batched by origin, mode and departure time — up to 25 destinations, the proxy's own limit. */
export interface TravelLookupRequestGroup {
  step: TravelLookupStep;
  originLocationId: string;
  destinationLocationIds: string[];
  mode: TransportMode;
  departureAt: Date;
  allowReserve: boolean;
}

export interface BuildTravelLookupPlanInput {
  now: Date;
  timeZone: string;
  /** The local day's remaining elements (`TRAVEL_LOOKUP_DAILY_LIMIT - spent`, read by the tick route). */
  budgetRemaining: number;
  /** `derivedState.commitmentTimelines` from the latest `planning_runs.result`. */
  commitmentTimelines: readonly CommitmentTimelineWire[];
  /** `dayPlan` from the same result; absent reads as no plan-required legs for today. */
  dayPlan?: DayPlan;
  /** The per-cell summary `readJourneySummary` returns — the tick route's own read, not this planner's. */
  journeySummary: JourneySummary;
  /**
   * Where each day-plan travel block departs from: the location band active immediately before it
   * (`dayPlan.locations`), keyed by the block's own `startsAt` (ISO). The tick route derives this once
   * per block; kept as an argument rather than recomputed here so the same band lookup a test builds
   * by hand and the one the route builds from `dayPlan.locations` are provably the same map.
   */
  todayLegOrigins: ReadonlyMap<string, string>;
}

const MINUTE_MS = 60_000;
const TOLERANCE_MINUTES = 5;
/** Offsets before leave-by the live check fires at (the travel time model design note step 1). */
const LIVE_CHECK_OFFSETS_MINUTES = [60, 15] as const;
/** Tomorrow's first leg becomes due from this local hour onward (step 3). */
const TOMORROW_FIRST_LEG_LOCAL_HOUR = 18;
/** The two top-up ticks, in minutes since local midnight (step 5). */
const TOP_UP_FIRST_LOCAL_MINUTES = 22 * 60;
const TOP_UP_FINAL_LOCAL_MINUTES = 23 * 60 + 45;
/** Kept in reserve at the first top-up tick, for a late live check (step 5). */
const TOP_UP_FIRST_TICK_HOLDBACK = 2;
/** How far ahead the top-up step looks for cells the coming week's plan-required legs will use. */
const TOP_UP_HORIZON_DAYS = 7;

function withinMinutes(now: Date, target: Date, toleranceMinutes = TOLERANCE_MINUTES): boolean {
  return Math.abs(now.getTime() - target.getTime()) <= toleranceMinutes * MINUTE_MS;
}

function localMinutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

function withinLocalMinutes(now: Date, timeZone: string, targetMinutes: number, toleranceMinutes = TOLERANCE_MINUTES) {
  return Math.abs(localMinutesOfDay(now, timeZone) - targetMinutes) <= toleranceMinutes;
}

/** A DST-safe local wall-clock instant, the same construction `engine/core`'s `zonedDateTime` uses. */
function zonedInstant(localDateValue: string, minutesOfDay: number, timeZone: string): Date {
  const [year, month, day] = localDateValue.split("-").map(Number) as [number, number, number];
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let stamp = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(stamp));
    const take = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    stamp +=
      desired - Date.UTC(take("year"), take("month") - 1, take("day"), take("hour"), take("minute"), take("second"));
  }
  return new Date(stamp);
}

/** The next moment, at or after `now`, that falls in the given day type and band. */
function nextOccurrenceOf(dayType: "weekday" | "weekend", band: number, now: Date, timeZone: string): Date {
  const today = localDayIn(timeZone, now);
  for (let offset = 0; offset <= TOP_UP_HORIZON_DAYS + 1; offset += 1) {
    const dateValue = offset === 0 ? today : addLocalDays(today, offset);
    // Noon avoids a midnight DST ambiguity when reading back which day type this date is.
    const noon = zonedInstant(dateValue, 12 * 60, timeZone);
    if (journeyBand(noon, timeZone).dayType !== dayType) continue;
    const candidate = zonedInstant(dateValue, band * JOURNEY_BAND_MINUTES, timeZone);
    if (candidate.getTime() >= now.getTime()) return candidate;
  }
  return zonedInstant(today, band * JOURNEY_BAND_MINUTES, timeZone);
}

interface JourneyEdgeLeg {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  departureAt: Date;
}

/** Every `journeyBefore`/`journeyAfter` edge on the given timelines, with its own departure instant. */
function edgeLegsOf(timelines: readonly CommitmentTimelineWire[]): JourneyEdgeLeg[] {
  const legs: JourneyEdgeLeg[] = [];
  for (const timeline of timelines) {
    if (timeline.journeyBefore?.mode && timeline.leaveBy) {
      legs.push({
        fromLocationId: timeline.journeyBefore.fromLocationId,
        toLocationId: timeline.journeyBefore.toLocationId,
        mode: timeline.journeyBefore.mode,
        departureAt: new Date(timeline.leaveBy)
      });
    }
    if (timeline.journeyAfter?.mode) {
      legs.push({
        fromLocationId: timeline.journeyAfter.fromLocationId,
        toLocationId: timeline.journeyAfter.toLocationId,
        mode: timeline.journeyAfter.mode,
        departureAt: new Date(timeline.freeAt)
      });
    }
  }
  return legs;
}

/** Step 1: a live check once within ±5 minutes of 60, and once of 15, minutes before each leg's leave-by. */
function liveLegs(input: BuildTravelLookupPlanInput): TravelLookupLeg[] {
  const journeys = buildJourneyIndex(input.journeySummary);
  const legs: TravelLookupLeg[] = [];
  for (const edge of edgeLegsOf(input.commitmentTimelines)) {
    for (const offsetMinutes of LIVE_CHECK_OFFSETS_MINUTES) {
      const windowCenter = new Date(edge.departureAt.getTime() - offsetMinutes * MINUTE_MS);
      if (!withinMinutes(input.now, windowCenter)) continue;
      const latest = journeys.latest(edge.fromLocationId, edge.toLocationId, edge.mode);
      const done = latest ? withinMinutes(new Date(latest.observedAt), windowCenter) : false;
      if (done) continue;
      legs.push({
        step: "next_leg_live",
        fromLocationId: edge.fromLocationId,
        toLocationId: edge.toLocationId,
        mode: edge.mode,
        departureAt: input.now,
        allowReserve: true
      });
    }
  }
  return legs;
}

/**
 * Where each travel block in `dayPlan` departs from: the location band (`dayPlan.locations`) active
 * immediately before the block starts. A block with no such band (the current location is unknown)
 * is left out — the tick route cannot build a request for it without an origin's coordinates anyway.
 */
export function deriveTodayLegOrigins(dayPlan: DayPlan | undefined): Map<string, string> {
  const origins = new Map<string, string>();
  if (!dayPlan) return origins;
  for (const block of dayPlan.blocks) {
    if (block.kind !== "travel") continue;
    const startsAt = new Date(block.startsAt).getTime();
    let best: { endsAt: number; locationId: string } | undefined;
    for (const band of dayPlan.locations) {
      if (!band.locationId) continue;
      const endsAt = new Date(band.endsAt).getTime();
      if (endsAt > startsAt) continue;
      if (!best || endsAt > best.endsAt) best = { endsAt, locationId: band.locationId };
    }
    if (best) origins.set(block.startsAt, best.locationId);
  }
  return origins;
}

/** Step 2: each distinct remaining pair and mode on today's day plan, once per day. */
function todayLegs(input: BuildTravelLookupPlanInput): TravelLookupLeg[] {
  const journeys = buildJourneyIndex(input.journeySummary);
  const today = localDayIn(input.timeZone, input.now);
  const seen = new Set<string>();
  const legs: TravelLookupLeg[] = [];
  for (const block of input.dayPlan?.blocks ?? []) {
    if (block.kind !== "travel" || !block.toLocationId || !block.mode) continue;
    const departureAt = new Date(block.startsAt);
    if (departureAt.getTime() < input.now.getTime()) continue;
    if (localDayIn(input.timeZone, departureAt) !== today) continue;
    const fromLocationId = input.todayLegOrigins.get(block.startsAt);
    if (!fromLocationId) continue;
    const key = `${fromLocationId}\u0000${block.toLocationId}\u0000${block.mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const latest = journeys.latest(fromLocationId, block.toLocationId, block.mode);
    const alreadyToday =
      latest &&
      localDayIn(input.timeZone, new Date(latest.observedAt)) === today &&
      localDayIn(input.timeZone, new Date(latest.departedAt)) === today;
    if (alreadyToday) continue;
    legs.push({
      step: "today",
      fromLocationId,
      toLocationId: block.toLocationId,
      mode: block.mode,
      departureAt,
      allowReserve: false
    });
  }
  return legs;
}

/** Step 3: tomorrow's earliest plan-required leg, once, due from 18:00 local. */
function tomorrowFirstLeg(input: BuildTravelLookupPlanInput): TravelLookupLeg[] {
  if (localMinutesOfDay(input.now, input.timeZone) < TOMORROW_FIRST_LEG_LOCAL_HOUR * 60) return [];
  const journeys = buildJourneyIndex(input.journeySummary);
  const today = localDayIn(input.timeZone, input.now);
  const tomorrow = addLocalDays(today, 1);
  const candidates = edgeLegsOf(input.commitmentTimelines)
    .filter((edge) => localDayIn(input.timeZone, edge.departureAt) === tomorrow)
    .sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime());
  const first = candidates[0];
  if (!first) return [];
  const latest = journeys.latest(first.fromLocationId, first.toLocationId, first.mode);
  const alreadyRequested =
    latest &&
    localDayIn(input.timeZone, new Date(latest.observedAt)) === today &&
    localDayIn(input.timeZone, new Date(latest.departedAt)) === tomorrow;
  if (alreadyRequested) return [];
  return [
    {
      step: "tomorrow_first",
      fromLocationId: first.fromLocationId,
      toLocationId: first.toLocationId,
      mode: first.mode,
      departureAt: first.departureAt,
      allowReserve: false
    }
  ];
}

interface TopUpCandidate {
  fromLocationId: string;
  toLocationId: string;
  mode: TransportMode;
  dayType: "weekday" | "weekend";
  band: number;
  googleCount: number;
  nextOccurrenceAt: Date;
}

/** Step 5: the coming week's cells, fewest Google samples first, soonest cell on a tie. */
function topUpCandidates(input: BuildTravelLookupPlanInput): TopUpCandidate[] {
  const journeys = buildJourneyIndex(input.journeySummary);
  const horizonEnd = input.now.getTime() + TOP_UP_HORIZON_DAYS * 24 * 60 * MINUTE_MS;
  const seen = new Map<string, TopUpCandidate>();
  for (const edge of edgeLegsOf(input.commitmentTimelines)) {
    if (edge.departureAt.getTime() < input.now.getTime() || edge.departureAt.getTime() > horizonEnd) continue;
    const { dayType, band } = journeyBand(edge.departureAt, input.timeZone);
    const key = `${edge.fromLocationId}\u0000${edge.toLocationId}\u0000${edge.mode}\u0000${dayType}\u0000${band}`;
    if (seen.has(key)) continue;

    // Bike and walk pairs are measured once and never topped up: traffic does not change them, so any
    // Google sample already on record for this pair and mode, in any band, is enough forever.
    if (edge.mode !== "car") {
      const anyCell = journeys.cell(edge.fromLocationId, edge.toLocationId, edge.mode, null, null);
      const alreadyMeasuredOnce = anyCell && anyCell.pooled.count - anyCell.own.count > 0;
      if (alreadyMeasuredOnce) continue;
    }

    const cell = journeys.cell(edge.fromLocationId, edge.toLocationId, edge.mode, dayType, band);
    const googleCount = cell ? cell.pooled.count - cell.own.count : 0;
    seen.set(key, {
      fromLocationId: edge.fromLocationId,
      toLocationId: edge.toLocationId,
      mode: edge.mode,
      dayType,
      band,
      googleCount,
      nextOccurrenceAt: nextOccurrenceOf(dayType, band, input.now, input.timeZone)
    });
  }
  return [...seen.values()].sort(
    (a, b) => a.googleCount - b.googleCount || a.nextOccurrenceAt.getTime() - b.nextOccurrenceAt.getTime()
  );
}

/** Step 5's own due windows and how much of what is left it may spend, per the plan's two ticks. */
function topUpCapacity(now: Date, timeZone: string, safeRemaining: number): number {
  if (withinLocalMinutes(now, timeZone, TOP_UP_FINAL_LOCAL_MINUTES)) return Math.max(0, safeRemaining);
  if (withinLocalMinutes(now, timeZone, TOP_UP_FIRST_LOCAL_MINUTES))
    return Math.max(0, safeRemaining - TOP_UP_FIRST_TICK_HOLDBACK);
  return 0;
}

/**
 * The ordered lookups to spend on right now: live first (may spend the reserve), then today's legs,
 * tomorrow's first leg and the week's top-up (never below the reserve before 21:00 local), each
 * capped by what the day's budget has left. Grouped afterwards by origin, mode and departure time.
 */
export function buildTravelLookupPlan(input: BuildTravelLookupPlanInput): TravelLookupRequestGroup[] {
  const legs: TravelLookupLeg[] = [];
  let remaining = Math.max(0, input.budgetRemaining);

  const live = liveLegs(input).slice(0, remaining);
  legs.push(...live);
  remaining -= live.length;

  const reserveActive = !pastReserveHour(input.timeZone, input.now);
  let safeRemaining = reserveActive ? Math.max(0, remaining - TRAVEL_LOOKUP_RESERVE) : Math.max(0, remaining);

  const today = todayLegs(input).slice(0, safeRemaining);
  legs.push(...today);
  safeRemaining -= today.length;

  const tomorrow = tomorrowFirstLeg(input).slice(0, Math.max(0, safeRemaining));
  legs.push(...tomorrow);
  safeRemaining -= tomorrow.length;

  const topUpBudget = topUpCapacity(input.now, input.timeZone, safeRemaining);
  const topUp = topUpCandidates(input)
    .slice(0, topUpBudget)
    .map((candidate): TravelLookupLeg => ({
      step: "top_up",
      fromLocationId: candidate.fromLocationId,
      toLocationId: candidate.toLocationId,
      mode: candidate.mode,
      departureAt: candidate.nextOccurrenceAt,
      allowReserve: false
    }));
  legs.push(...topUp);

  return group(legs);
}

/** Whether `now`, read in `timeZone`, has reached the hour the reserve floor stops applying. */
function pastReserveHour(timeZone: string, now: Date): boolean {
  return localMinutesOfDay(now, timeZone) >= TRAVEL_LOOKUP_RESERVE_HOUR * 60;
}

const MAX_DESTINATIONS_PER_GROUP = 25;

/** Batches legs sharing an origin, mode and exact departure instant, up to 25 destinations each. */
function group(legs: TravelLookupLeg[]): TravelLookupRequestGroup[] {
  const groups: TravelLookupRequestGroup[] = [];
  const index = new Map<string, TravelLookupRequestGroup>();
  for (const leg of legs) {
    const key = `${leg.step}\u0000${leg.fromLocationId}\u0000${leg.mode}\u0000${leg.departureAt.getTime()}`;
    const existing = index.get(key);
    if (existing && existing.destinationLocationIds.length < MAX_DESTINATIONS_PER_GROUP) {
      if (!existing.destinationLocationIds.includes(leg.toLocationId))
        existing.destinationLocationIds.push(leg.toLocationId);
      continue;
    }
    const created: TravelLookupRequestGroup = {
      step: leg.step,
      originLocationId: leg.fromLocationId,
      destinationLocationIds: [leg.toLocationId],
      mode: leg.mode,
      departureAt: leg.departureAt,
      allowReserve: leg.allowReserve
    };
    groups.push(created);
    index.set(key, created);
  }
  return groups;
}

export {
  TOP_UP_FINAL_LOCAL_MINUTES,
  TOP_UP_FIRST_LOCAL_MINUTES,
  TOP_UP_FIRST_TICK_HOLDBACK,
  TOP_UP_HORIZON_DAYS,
  TOMORROW_FIRST_LEG_LOCAL_HOUR,
  LIVE_CHECK_OFFSETS_MINUTES,
  TRAVEL_LOOKUP_DAILY_LIMIT
};
