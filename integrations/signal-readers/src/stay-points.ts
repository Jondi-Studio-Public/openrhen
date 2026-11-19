/**
 * detectStayPoints: pure stay detection over position fixes.
 *
 * The caller reads fixes from whatever the registry declares as position inputs and hands them in with their accuracy
 * already resolved (a default applied where the source gave none), so nothing here knows a source or a provider. The
 * function does no I/O and never reads the clock: `options.now` is the time the answer is asked for.
 *
 * Contract for open and closed stays:
 * - Only fixes with `ingestedAt <= now` are used, so the answer at `now` is the fold over everything ingested by then.
 * - Every stay has a `closeTime`, the moment its end became knowable. It is the later of the `ingestedAt` of the row
 *   that closed it and the `ingestedAt` of its own fixes. A fix outside the window, or a fix after a gap, closes it
 *   with that fix's `ingestedAt`; across a gap longer than 90 minutes the close time is no later than last fix + 12 h,
 *   when no bridge is possible any more. A stay with no closing fix yet closes at last fix + 12 h.
 * - `open` is `closeTime > now`. An open stay reports `toBound === to` and `endApprox === false`, because nothing is
 *   known about its end yet. A closed stay's `toBound` is the `ts` of the closing fix, or last fix + 12 h when that
 *   comes first (or when nothing closed it), and `endApprox` is true when `toBound - to` exceeds 30 minutes.
 */

export type PositionMotion = "automotive" | "cycling" | (string & {});

export type PositionFix = {
  /** Epoch ms of the fix itself. */
  ts: number;
  lat: number;
  lng: number;
  /** Metres, already resolved by the caller. A fix with none is left out of the median, so a stay of such fixes has median 0 and the 50 m minimum window. */
  accuracyM?: number;
  /** The declared input the fix came from; stays are found per route and then merged across routes. */
  routeKey: string;
  motion?: PositionMotion;
  snapped?: boolean;
  /** False for a position that may only join an existing cluster. Carried through to the stay. */
  mints: boolean;
  eventKey: string;
  /** Epoch ms the row was recorded. */
  ingestedAt: number;
};

export type StayPointOptions = {
  /** The time the answer is asked for, epoch ms. Fixes ingested after it are not seen. */
  now: number;
};

export type StayPoint = {
  from: number;
  to: number;
  toBound: number;
  endApprox: boolean;
  centroid: { lat: number; lng: number };
  medianAccuracyM: number;
  approximate: boolean;
  routes: string[];
  inputEventKeys: string[];
  mints: boolean;
  /** Epoch ms at which the end of the stay became knowable. */
  closeTime: number;
  /** True while `closeTime` has not passed. */
  open: boolean;
};

export const MAX_FIX_ACCURACY_M = 200;
export const MIN_WINDOW_M = 50;
export const WINDOW_ACCURACY_FACTOR = 2;
export const GAP_LIMIT_MS = 90 * 60_000;
export const BRIDGE_CAP_MS = 12 * 3_600_000;
export const MIN_STAY_MS = 5 * 60_000;
export const APPROXIMATE_ACCURACY_M = 75;
export const VEHICLE_SPEED_MPS = 1.5;
export const MERGE_OVERLAP = 0.5;
export const END_APPROX_MS = 30 * 60_000;

const EARTH_RADIUS_M = 6_371_008.8;
const VEHICLE_MOTIONS = new Set(["automotive", "cycling"]);

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function windowM(medianAccuracyM: number): number {
  return Math.max(MIN_WINDOW_M, WINDOW_ACCURACY_FACTOR * medianAccuracyM);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFixes(a: PositionFix, b: PositionFix): number {
  return a.ts - b.ts || a.ingestedAt - b.ingestedAt || compareText(a.eventKey, b.eventKey);
}

/** A run of fixes inside one window. `accuracies` is kept sorted so the median is read, not recomputed, per fix. */
type Group = { fixes: PositionFix[]; sumLat: number; sumLng: number; accuracies: number[]; ownIngested: number };

function insertSorted(sorted: number[], value: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}

function newGroup(fix: PositionFix): Group {
  const group: Group = { fixes: [fix], sumLat: fix.lat, sumLng: fix.lng, accuracies: [], ownIngested: fix.ingestedAt };
  if (fix.accuracyM !== undefined) group.accuracies.push(fix.accuracyM);
  return group;
}

function sortedMedian(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function groupCentroid(group: Group): { lat: number; lng: number } {
  return { lat: group.sumLat / group.fixes.length, lng: group.sumLng / group.fixes.length };
}

function addToGroup(group: Group, fix: PositionFix): void {
  group.fixes.push(fix);
  group.sumLat += fix.lat;
  group.sumLng += fix.lng;
  if (fix.accuracyM !== undefined) insertSorted(group.accuracies, fix.accuracyM);
  if (fix.ingestedAt > group.ownIngested) group.ownIngested = fix.ingestedAt;
}

/** Motion over more than half the stay by time, or a median speed above the limit, means a vehicle segment. */
function isVehicleSegment(fixes: readonly PositionFix[]): boolean {
  let vehicleMs = 0;
  let totalMs = 0;
  const speeds: number[] = [];
  for (let i = 0; i + 1 < fixes.length; i += 1) {
    const here = fixes[i]!;
    const next = fixes[i + 1]!;
    const dt = next.ts - here.ts;
    totalMs += dt;
    if (here.motion !== undefined && VEHICLE_MOTIONS.has(here.motion)) vehicleMs += dt;
    if (dt > 0) speeds.push(distanceM(here, next) / (dt / 1000));
  }
  return vehicleMs * 2 > totalMs || median(speeds) > VEHICLE_SPEED_MPS;
}

type Closer = { ts: number; ingestedAt: number } | null;

function finishGroup(group: Group, closer: Closer, now: number): StayPoint | null {
  const fixes = group.fixes;
  if (fixes.length < 2) return null;
  const first = fixes[0]!;
  const last = fixes[fixes.length - 1]!;
  if (last.ts - first.ts < MIN_STAY_MS) return null;
  if (isVehicleSegment(fixes)) return null;

  const capTs = last.ts + BRIDGE_CAP_MS;
  const ownIngested = group.ownIngested;
  const gapLong = closer !== null && closer.ts - last.ts > GAP_LIMIT_MS;
  let toBound: number;
  let closeTime: number;
  if (closer === null) {
    toBound = capTs;
    closeTime = capTs;
  } else if (gapLong) {
    toBound = Math.min(closer.ts, capTs);
    closeTime = Math.min(closer.ingestedAt, capTs);
  } else {
    toBound = closer.ts;
    closeTime = closer.ingestedAt;
  }
  closeTime = Math.max(closeTime, ownIngested);
  const open = closeTime > now;
  if (open) toBound = last.ts;
  const accuracy = sortedMedian(group.accuracies);
  return {
    from: first.ts,
    to: last.ts,
    toBound,
    endApprox: !open && toBound - last.ts > END_APPROX_MS,
    centroid: groupCentroid(group),
    medianAccuracyM: accuracy,
    approximate: accuracy > APPROXIMATE_ACCURACY_M,
    routes: [first.routeKey],
    inputEventKeys: fixes.map((fix) => fix.eventKey).sort(compareText),
    mints: fixes.some((fix) => fix.mints),
    closeTime,
    open
  };
}

/** The first fix of any route strictly between two instants that lies outside `limitM` of a point, or undefined. */
function firstFixElsewhere(
  all: readonly PositionFix[],
  fromTs: number,
  toTs: number,
  centre: { lat: number; lng: number },
  limitM: number
): PositionFix | undefined {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid]!.ts <= fromTs) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < all.length && all[i]!.ts < toTs; i += 1) if (distanceM(all[i]!, centre) > limitM) return all[i];
  return undefined;
}

/** Stays on one route; `fixes` and `all` (the fixes of every route) are already filtered and sorted by time. */
function detectOnRoute(fixes: readonly PositionFix[], all: readonly PositionFix[], now: number): StayPoint[] {
  const stays: StayPoint[] = [];
  let group: Group | null = null;
  const close = (closer: Closer): void => {
    if (group === null) return;
    const stay = finishGroup(group, closer, now);
    if (stay !== null) stays.push(stay);
    group = null;
  };
  for (const fix of fixes) {
    if (group === null) {
      group = newGroup(fix);
      continue;
    }
    const last = group.fixes[group.fixes.length - 1]!;
    const window = windowM(sortedMedian(group.accuracies));
    const within = distanceM(fix, groupCentroid(group)) <= window;
    if (!within) {
      close({ ts: fix.ts, ingestedAt: fix.ingestedAt });
      group = newGroup(fix);
      continue;
    }
    const gap = fix.ts - last.ts;
    // Both sides of a gap sit inside the window (the group only holds fixes inside it). A long gap is bridged only
    // when it is under 12 h and no fix of any route lies elsewhere inside it; such a fix closes the stay instead.
    if (gap > GAP_LIMIT_MS) {
      const elsewhere =
        gap >= BRIDGE_CAP_MS ? fix : firstFixElsewhere(all, last.ts, fix.ts, groupCentroid(group), window);
      if (elsewhere !== undefined) {
        close({ ts: elsewhere.ts, ingestedAt: elsewhere.ingestedAt });
        group = newGroup(fix);
        continue;
      }
    }
    addToGroup(group, fix);
  }
  close(null);
  return stays;
}

function overlapRatio(a: StayPoint, b: StayPoint): number {
  const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.to - a.from, b.to - b.from);
}

function sameVisit(a: StayPoint, b: StayPoint): boolean {
  if (a.routes[0] === b.routes[0]) return false;
  if (overlapRatio(a, b) < MERGE_OVERLAP) return false;
  const window = Math.max(windowM(a.medianAccuracyM), windowM(b.medianAccuracyM));
  return distanceM(a.centroid, b.centroid) <= window;
}

function compareStays(a: StayPoint, b: StayPoint): number {
  return (
    a.from - b.from ||
    a.to - b.to ||
    compareText(a.routes.join("\u0000"), b.routes.join("\u0000")) ||
    compareText(a.inputEventKeys.join("\u0000"), b.inputEventKeys.join("\u0000"))
  );
}

/** Stays from different routes that are one visit become one, with the bounds of the most accurate route. */
function mergeAcrossRoutes(stays: StayPoint[]): StayPoint[] {
  const sorted = [...stays].sort(compareStays);
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  for (let i = 0; i < sorted.length; i += 1)
    for (let j = i + 1; j < sorted.length; j += 1) if (sameVisit(sorted[i]!, sorted[j]!)) parent[find(j)] = find(i);

  const members = new Map<number, StayPoint[]>();
  sorted.forEach((stay, index) => {
    const root = find(index);
    members.set(root, [...(members.get(root) ?? []), stay]);
  });
  const merged: StayPoint[] = [];
  for (const group of members.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    const best = [...group].sort((a, b) => a.medianAccuracyM - b.medianAccuracyM || compareStays(a, b))[0]!;
    merged.push({
      ...best,
      routes: [...new Set(group.flatMap((stay) => stay.routes))].sort(compareText),
      inputEventKeys: [...new Set(group.flatMap((stay) => stay.inputEventKeys))].sort(compareText),
      mints: group.some((stay) => stay.mints)
    });
  }
  return merged.sort(compareStays);
}

export function detectStayPoints(fixes: readonly PositionFix[], options: StayPointOptions): StayPoint[] {
  const { now } = options;
  const byRoute = new Map<string, PositionFix[]>();
  const all: PositionFix[] = [];
  for (const fix of fixes) {
    if (fix.ingestedAt > now) continue;
    if (fix.accuracyM !== undefined && fix.accuracyM > MAX_FIX_ACCURACY_M) continue;
    all.push(fix);
    const list = byRoute.get(fix.routeKey);
    if (list === undefined) byRoute.set(fix.routeKey, [fix]);
    else list.push(fix);
  }
  all.sort(compareFixes);
  const stays: StayPoint[] = [];
  for (const routeFixes of byRoute.values()) stays.push(...detectOnRoute(routeFixes.sort(compareFixes), all, now));
  return mergeAcrossRoutes(stays);
}
