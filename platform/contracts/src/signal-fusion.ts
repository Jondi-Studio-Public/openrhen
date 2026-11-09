/**
 * Pure availability maths: `classifySource`, `evidenceFreshness`, `fuseState`, `fuseContinuous` and `fuseLedger`.
 * No database access, no I/O, no clock: every function takes `now` as an argument. Nothing in the engine, the pulse
 * or the scheduler reads this file. Design: new-data-sources-design sections 2.3 and 2.4, with the r1-r4 responses.
 */
import {
  TIER_CEILING,
  type EvidenceItem,
  type FreshnessMode,
  type RouteTier,
  type SignalHold,
  type SignalName,
  type SlotBy,
  type SourceAvailability
} from "./signal-availability.js";

export type TimeInput = Date | number | string;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** An item observed more than this far ahead of `now` is not evidence. */
export const CLOCK_SKEW_MINUTES = 5;
/** `support[v]` never exceeds this, however many origins back `v`. */
export const SUPPORT_CAP = 0.95;
/** A scope is known when it appears in rows or coverage within this many days of the window. */
export const KNOWN_SCOPE_DAYS = 90;

function toMs(t: TimeInput): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return Date.parse(t);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/* ------------------------------------------------------------------ classifySource */

export type SourceState = "absent" | "errored" | "import_only" | "live" | "periodic" | "silent";

/** The part of the per-source book `classifySource` reads (design 2.3). A malformed or missing book is `undefined`. */
export interface AvailabilityBookView {
  firstSeenAt?: string | null;
  retiredAt?: string | null;
  lastLiveIngestAt?: string | null;
  devices?: Readonly<Record<string, { okAt: string | null; error: { at: string } | null }>>;
}

export interface SourceClassification {
  state: SourceState;
  /** Minutes since the last live ingest (live, periodic, silent); null when unknown or not applicable. */
  ageMinutes: number | null;
  /** The device whose error is newest, when `errored`. */
  device?: string;
  /** The source's own next-step line, when `errored` or `silent`. */
  recoveryHint?: string;
}

/** The minutes of quiet after which a live or periodic source is `silent`; undefined means it is never silent. */
export function silentAfterMinutes(availability: SourceAvailability): number | undefined {
  if (availability.silentAfterMinutes !== undefined) return availability.silentAfterMinutes;
  if (availability.expectedEveryMinutes !== undefined) return 3 * availability.expectedEveryMinutes;
  return undefined;
}

/**
 * Design 2.3, checked in this order: absent, errored, import_only, then live, periodic or silent.
 * Returns `undefined` for an entry with no `availability` (`derived`, `derived-shadow`, `place`): those are
 * projections, not routes, and never appear in a route set.
 */
export function classifySource(
  entry: { availability?: SourceAvailability },
  book: AvailabilityBookView | null | undefined,
  now: TimeInput
): SourceClassification | undefined {
  const availability = entry.availability;
  if (!availability) return undefined;
  if (!book || !book.firstSeenAt || book.retiredAt) return { state: "absent", ageMinutes: null };

  const nowMs = toMs(now);
  let erroredDevice: { device: string; at: number } | undefined;
  for (const device of Object.keys(book.devices ?? {}).sort()) {
    const d = book.devices![device]!;
    if (!d.error) continue;
    const at = toMs(d.error.at);
    const ok = d.okAt === null ? -Infinity : toMs(d.okAt);
    if (Number.isNaN(at) || !(at > ok)) continue;
    if (!erroredDevice || at > erroredDevice.at) erroredDevice = { device, at };
  }
  if (erroredDevice)
    return {
      state: "errored",
      ageMinutes: null,
      device: erroredDevice.device,
      recoveryHint: availability.recoveryHint
    };

  if (availability.delivery === "import") return { state: "import_only", ageMinutes: null };

  const lastMs = book.lastLiveIngestAt ? toMs(book.lastLiveIngestAt) : NaN;
  const ageMinutes = Number.isNaN(lastMs) ? null : Math.max(0, (nowMs - lastMs) / MINUTE_MS);
  const limit = silentAfterMinutes(availability);
  // Seen but never delivered live: nothing has arrived within any window, so it is silent when a limit exists.
  if (limit !== undefined && (ageMinutes === null || ageMinutes > limit))
    return { state: "silent", ageMinutes, recoveryHint: availability.recoveryHint };
  return { state: availability.delivery, ageMinutes };
}

/** The entries that are routes: those with `availability`. Route sets, data-health lists and harness sets use this. */
export function routeEntries<E extends { availability?: SourceAvailability }>(
  sources: Readonly<Record<string, E>>
): [string, E & { availability: SourceAvailability }][] {
  return Object.entries(sources).filter(
    (pair): pair is [string, E & { availability: SourceAvailability }] => pair[1].availability !== undefined
  );
}

/* ------------------------------------------------------------------ freshness */

/** Half-life and max age in minutes for a state signal's default (sampled) freshness. Design 2.4 table. */
export const SIGNAL_FRESHNESS: Readonly<Partial<Record<SignalName, { halfLifeMinutes: number; maxMinutes: number }>>> =
  Object.freeze({
    position: { halfLifeMinutes: 15, maxMinutes: 480 },
    motion_state: { halfLifeMinutes: 5, maxMinutes: 30 },
    presence_home: { halfLifeMinutes: 30, maxMinutes: 360 },
    device_attention: { halfLifeMinutes: 2, maxMinutes: 15 },
    weather: { halfLifeMinutes: 60, maxMinutes: 360 },
    // Vehicle readers (odometer, fuel level) must supply `holds` on their feed: this default decays in minutes, so a
    // reading taken hours ago would score near 0 without it. The default is kept as is.
    vehicle: { halfLifeMinutes: 10, maxMinutes: 30 * 24 * 60 },
    // The design gives "its 180-day window" and no half-life: no decay inside the window.
    travel_time: { halfLifeMinutes: Infinity, maxMinutes: 180 * 24 * 60 }
  });

export interface FreshnessInput {
  ageMinutes: number;
  halfLifeMinutes: number;
  maxMinutes: number;
  mode?: FreshnessMode | undefined;
  /** `refreshed-held`: minutes since the last same-state re-post (defaults to `ageMinutes`). */
  sinceRepostMinutes?: number | undefined;
  /** `refreshed-held`: required. */
  staleAfterMinutes?: number | undefined;
}

/**
 * `decay`: f = 0.5^(age / halfLife), 0 past the max age; an `Infinity` half-life gives f = 1 (until the max age).
 * At age 0 f is 1 for any half-life (a half-life of 0 or less decays at once: f = 0 for any age above 0).
 * `refreshed-held`: f = 1 while the same (route, state) was re-posted within `staleAfterMinutes`, else 0. It never
 * rises as age grows.
 */
export function evidenceFreshness(input: FreshnessInput): number {
  const age = Math.max(0, input.ageMinutes);
  if (input.mode === "refreshed-held") {
    const since = Math.max(0, input.sinceRepostMinutes ?? age);
    const stale = input.staleAfterMinutes;
    return stale !== undefined && Number.isFinite(stale) && since <= stale ? 1 : 0;
  }
  if (age > input.maxMinutes) return 0;
  if (input.halfLifeMinutes === Infinity || age === 0) return 1;
  if (!(input.halfLifeMinutes > 0)) return 0;
  return Math.pow(0.5, age / input.halfLifeMinutes);
}

/** c = min(weight, TIER_CEILING[tier]) x f. The ceiling applies at read time, so an extension source cannot exceed it. */
export function evidenceConfidence(tier: RouteTier, weight: number, freshness: number): number {
  return Math.min(clamp01(weight), TIER_CEILING[tier] ?? 0) * clamp01(freshness);
}

/** A consumer's blend weight: `consumerWeight x conf` (or `x completeness` for ledgers). P4: never above either factor. */
export function scaleConsumerWeight(consumerWeight: number, confidence: number): number {
  return clamp01(consumerWeight) * clamp01(confidence);
}

/* ------------------------------------------------------------------ state fusion */

/** An evidence item plus the feed policy that decides its freshness and slot. Readers copy the policy from the feed. */
export interface FusionItem extends EvidenceItem {
  kind?: string;
  device?: string;
  /** `attrs.label`, for `slotBy: "route"`. */
  label?: string;
  slotBy?: SlotBy;
  freshness?: FreshnessMode;
  staleAfterMinutes?: number;
  holds?: SignalHold;
  /** The newest re-post of the same state, for `refreshed-held`; defaults to `observedAt`. */
  lastRepostedAt?: string;
}

export interface FusedSlot {
  slot: string;
  source: string;
  origin: string;
  value: unknown;
  c: number;
}

export interface FusedSupport {
  key: string;
  value: unknown;
  support: number;
}

export interface FusedState {
  signal: SignalName;
  /** The argmax of support, or null with no evidence. */
  value: unknown;
  /** max(0, support[best] - support[runnerUp]); 0 with no evidence. */
  conf: number;
  /** support[best], 0 with no evidence. */
  supportBest: number;
  /** Every backed value, highest support first (ties by key). */
  support: FusedSupport[];
  /** 1 - product(1 - c) over all slots. */
  coverage: number;
  /**
   * Slots disagree on the value. Explanations only; it never changes the numbers. Slots are the unit of dissent, so
   * under `slotBy: "device"` or `"route"` two slots of one origin that disagree count as contested, even though they
   * share a vantage point (that is the point of asking for finer slots).
   */
  contested: boolean;
  slots: FusedSlot[];
}

/** A stable string for any JSON-like value: object keys sorted. */
export function canonicalValueKey(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValueKey).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalValueKey(o[k])}`)
    .join(",")}}`;
}

export function slotKeyOf(item: Pick<FusionItem, "origin" | "device" | "label" | "slotBy">): string {
  const by = item.slotBy ?? "origin";
  if (by === "origin") return item.origin;
  if (by === "device") return `${item.origin}:${item.device ?? "_"}`;
  return `${item.origin}:${item.device ?? "_"}:${item.label ?? "_"}`;
}

interface LiveItem {
  item: FusionItem;
  slot: string;
  observedMs: number;
  valueKey: string;
  c: number;
}

function liveSlots(signal: SignalName, items: readonly FusionItem[], nowInput: TimeInput): LiveItem[] {
  const nowMs = toMs(nowInput);
  const skewLimit = nowMs + CLOCK_SKEW_MINUTES * MINUTE_MS;
  // Items for this signal that are readable and not from the future. Subject is deliberately ignored here.
  const candidates = items
    .filter((item) => item.signal === signal)
    .map((item) => ({
      item,
      observedMs: toMs(item.observedAt),
      repostMs: item.lastRepostedAt === undefined ? undefined : toMs(item.lastRepostedAt),
      valueKey: canonicalValueKey(item.value)
    }))
    .filter(
      (x) =>
        !Number.isNaN(x.observedMs) &&
        x.observedMs <= skewLimit &&
        (x.repostMs === undefined || (!Number.isNaN(x.repostMs) && x.repostMs <= skewLimit))
    );

  // A held state ends at a closing kind, or a fresher opposite value, from any route of the same origin.
  const open = candidates.filter((x) => {
    const holds = x.item.holds;
    if (!holds) return true;
    return !candidates.some(
      (y) =>
        y !== x &&
        y.item.origin === x.item.origin &&
        y.observedMs > x.observedMs &&
        ((y.item.kind !== undefined && holds.closedBy.includes(y.item.kind)) || y.valueKey !== x.valueKey)
    );
  });

  const withC = open.map((x) => {
    const holds = x.item.holds;
    const base = SIGNAL_FRESHNESS[signal] ?? { halfLifeMinutes: Infinity, maxMinutes: Infinity };
    const age = Math.max(0, (nowMs - x.observedMs) / MINUTE_MS);
    const f = evidenceFreshness({
      ageMinutes: age,
      halfLifeMinutes: holds ? holds.halfLifeMinutes : base.halfLifeMinutes,
      maxMinutes: holds ? holds.maxMinutes : base.maxMinutes,
      mode: x.item.freshness,
      sinceRepostMinutes: x.repostMs === undefined ? age : Math.max(0, (nowMs - x.repostMs) / MINUTE_MS),
      staleAfterMinutes: x.item.staleAfterMinutes
    });
    return {
      item: x.item,
      slot: slotKeyOf(x.item),
      observedMs: x.observedMs,
      valueKey: x.valueKey,
      c: evidenceConfidence(x.item.tier, x.item.weight, f)
    };
  });

  // One item per slot: the newest, ties to the higher c, then source and value for determinism. A superseded
  // item never resurfaces once the newest has expired (that would let support rise as `now` moves forward).
  const bySlot = new Map<string, LiveItem>();
  for (const x of withC) {
    const cur = bySlot.get(x.slot);
    if (!cur || beats(x, cur)) bySlot.set(x.slot, x);
  }
  return [...bySlot.values()].filter((x) => x.c > 0).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

function beats(a: LiveItem, b: LiveItem): boolean {
  if (a.observedMs !== b.observedMs) return a.observedMs > b.observedMs;
  if (a.c !== b.c) return a.c > b.c;
  if (a.item.source !== b.item.source) return a.item.source < b.item.source;
  return a.valueKey < b.valueKey;
}

/**
 * State fusion for one signal (design 2.4). Per slot (origin by default, or device or route per `slotBy`) the
 * newest item; `support[v] = 1 - product(1 - c)` over the slots backing v, capped at 0.95; the value is the argmax and
 * `conf = max(0, best - runnerUp)`. `subject` is ignored: callers filter before fusion. A silent route past its max
 * age contributes nothing, exactly like an absent one (P5).
 */
export function fuseState(signal: SignalName, items: readonly FusionItem[], now: TimeInput): FusedState {
  const live = liveSlots(signal, items, now);
  const groups = new Map<string, { value: unknown; keep: number; slots: LiveItem[] }>();
  let none = 1;
  for (const x of live) {
    none *= 1 - x.c;
    const g = groups.get(x.valueKey) ?? { value: x.item.value, keep: 1, slots: [] };
    g.keep *= 1 - x.c;
    g.slots.push(x);
    groups.set(x.valueKey, g);
  }
  const support: FusedSupport[] = [...groups.entries()]
    .map(([key, g]) => ({ key, value: g.value, support: Math.min(SUPPORT_CAP, 1 - g.keep) }))
    .sort((a, b) => b.support - a.support || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const best = support[0];
  const runnerUp = support[1];
  const supportBest = best?.support ?? 0;
  return {
    signal,
    value: best ? best.value : null,
    conf: best ? Math.max(0, supportBest - (runnerUp?.support ?? 0)) : 0,
    supportBest,
    support,
    coverage: live.length ? 1 - none : 0,
    contested: groups.size > 1,
    slots: live.map((x) => ({
      slot: x.slot,
      source: x.item.source,
      origin: x.item.origin,
      value: x.item.value,
      c: x.c
    }))
  };
}

/** `device_attention` fuses per device: one result per `value.deviceId`, never across devices. */
export function fuseDeviceAttention(items: readonly FusionItem[], now: TimeInput): Record<string, FusedState> {
  const byDevice = new Map<string, FusionItem[]>();
  for (const item of items) {
    if (item.signal !== "device_attention") continue;
    const id = (item.value as { deviceId?: unknown } | null)?.deviceId;
    if (typeof id !== "string") continue;
    byDevice.set(id, [...(byDevice.get(id) ?? []), item]);
  }
  const out: Record<string, FusedState> = {};
  for (const id of [...byDevice.keys()].sort()) out[id] = fuseState("device_attention", byDevice.get(id)!, now);
  return out;
}

export interface FusedContinuous {
  signal: SignalName;
  value: unknown;
  /** The chosen item's c; 0 with no evidence. */
  conf: number;
  source: string | null;
  origin: string | null;
  tier: RouteTier | null;
}

const TIER_RANK: Readonly<Record<RouteTier, number>> = { live: 3, periodic: 2, import: 1, inferred: 0 };

/**
 * Continuous signals (weather, vehicle readings) are not voted on: one item is chosen and `conf` is its own c.
 * The design says "the newest item of the highest-tier origin". Taken literally that breaks P3 (a high tier item with
 * a small weight can expire and hand over to a lower tier item with a bigger c), so this picks the highest c per
 * slot-newest item, ties to the higher tier, then the newer, then the source name.
 */
export function fuseContinuous(signal: SignalName, items: readonly FusionItem[], now: TimeInput): FusedContinuous {
  const live = liveSlots(signal, items, now);
  let best: LiveItem | undefined;
  for (const x of live) {
    if (!best) best = x;
    else if (x.c !== best.c) best = x.c > best.c ? x : best;
    else if (x.item.tier !== best.item.tier) best = TIER_RANK[x.item.tier] > TIER_RANK[best.item.tier] ? x : best;
    else if (x.observedMs !== best.observedMs) best = x.observedMs > best.observedMs ? x : best;
    else if (x.item.source < best.item.source) best = x;
  }
  return best
    ? {
        signal,
        value: best.item.value,
        conf: best.c,
        source: best.item.source,
        origin: best.item.origin,
        tier: best.item.tier
      }
    : { signal, value: null, conf: 0, source: null, origin: null, tier: null };
}

/* ------------------------------------------------------------------ ledger fusion */

/** One deduplicated ledger row, reduced to what scoping needs. */
export interface LedgerRowRef {
  source: string;
  scope?: string | null;
  at: string;
  /** A row that only evidences part of a scope (a tap, a receipt): it never forms a scope (design 2.4). */
  subset?: true;
}

/** A coverage row, or an import extent for one scope that carries rows. */
export interface CoverageClaim {
  kind: "coverage" | "import";
  source: string;
  scope?: string | null | undefined;
  /** The coverage row's canonical key (`cov:...`); used to match a retraction. */
  key?: string | undefined;
  from: string;
  to: string;
  ingestedAt: string;
  tier: RouteTier;
}

/** A `correction` row whose `attrs.corrects` names a coverage key. It retracts only rows ingested before it. */
export interface CoverageRetraction {
  source: string;
  corrects: string;
  ingestedAt: string;
}

export interface FuseLedgerInput {
  now: TimeInput;
  window: { from: string; to: string };
  rows: readonly LedgerRowRef[];
  claims: readonly CoverageClaim[];
  retractions?: readonly CoverageRetraction[] | undefined;
  /** Retired sources are excluded entirely, so their scopes stop being known. */
  retiredSources?: readonly string[] | undefined;
  /** Per source; every claim is clipped to `now - retentionDays`. A source with no entry is not clipped. */
  retentionDays?: Readonly<Record<string, number>> | undefined;
}

export interface LedgerScope {
  scope: string;
  /** Covered share of the window, 0..1. */
  share: number;
  /** The uncovered parts of the window, so gaps stay visible. */
  gaps: { from: string; to: string }[];
  /** The weakest tier among the claims that cover part of the window; null when nothing covers it. */
  trust: RouteTier | null;
}

export interface FusedLedger {
  /** Minimum over known scopes of the covered share; 0 with no known scope or an empty window. */
  completeness: number;
  scopes: LedgerScope[];
  /** Set when the window or `now` is not a usable finite interval; completeness is then 0. */
  problem?: string;
  /** The weakest trust over scopes with any coverage; reported apart from completeness. */
  trust: RouteTier | null;
}

const NO_SCOPE = "_";

function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function weakerTier(a: RouteTier | null, b: RouteTier): RouteTier {
  return a === null || TIER_RANK[b] < TIER_RANK[a] ? b : a;
}

/**
 * Ledger completeness (design 2.4, r3 H2, r4 M1/M2/M7). For a window: each known scope's covered share is the length
 * of the union of its coverage rows and import extents (retracted rows dropped, retired sources dropped, every
 * interval clipped to retention, to the window and to `now`) over the window's length; completeness is the minimum over
 * known scopes. A scope with rows but no coverage scores 0. Nothing is extrapolated.
 */
export function fuseLedger(input: FuseLedgerInput): FusedLedger {
  const nowMs = toMs(input.now);
  const fromMs = toMs(input.window.from);
  const toMsV = toMs(input.window.to);
  const empty: FusedLedger = { completeness: 0, scopes: [], trust: null };
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMsV) || !Number.isFinite(nowMs))
    return { ...empty, problem: "Invalid window: from, to and now must be finite times." };
  if (!(toMsV > fromMs)) return empty;

  const retired = new Set(input.retiredSources ?? []);
  const scopeOf = (s: string | null | undefined) => (s === undefined || s === null || s === "" ? NO_SCOPE : s);

  const nearFrom = fromMs - KNOWN_SCOPE_DAYS * DAY_MS;
  const nearTo = toMsV + KNOWN_SCOPE_DAYS * DAY_MS;
  const known = new Set<string>();
  for (const row of input.rows) {
    const at = toMs(row.at);
    if (row.subset || retired.has(row.source) || Number.isNaN(at) || at < nearFrom || at > nearTo) continue;
    known.add(scopeOf(row.scope));
  }

  const retractions = input.retractions ?? [];
  const perScope = new Map<string, { intervals: [number, number][]; trust: RouteTier | null }>();
  for (const claim of input.claims) {
    if (retired.has(claim.source)) continue;
    const a = toMs(claim.from);
    const b = toMs(claim.to);
    const ingested = toMs(claim.ingestedAt);
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(ingested)) continue;
    // A claim in sight makes its scope known even when retracted or clipped away: the scope then scores 0.
    if (b >= nearFrom && a <= nearTo) known.add(scopeOf(claim.scope));
    if (
      claim.kind === "coverage" &&
      claim.key !== undefined &&
      retractions.some((r) => r.source === claim.source && r.corrects === claim.key && toMs(r.ingestedAt) > ingested)
    )
      continue;
    const days = input.retentionDays?.[claim.source];
    const floor = days === undefined ? -Infinity : nowMs - days * DAY_MS;
    const lo = Math.max(a, floor, fromMs);
    // A claim cannot cover time that has not happened yet.
    const hi = Math.min(b, toMsV, nowMs);
    if (!(hi > lo)) continue;
    const key = scopeOf(claim.scope);
    const slot = perScope.get(key) ?? { intervals: [], trust: null };
    slot.intervals.push([lo, hi]);
    slot.trust = weakerTier(slot.trust, claim.tier);
    perScope.set(key, slot);
  }

  const length = toMsV - fromMs;
  const scopes: LedgerScope[] = [...known].sort().map((scope) => {
    const slot = perScope.get(scope);
    const merged = mergeIntervals(slot?.intervals ?? []);
    const covered = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
    const gaps: { from: string; to: string }[] = [];
    let cursor = fromMs;
    for (const [a, b] of merged) {
      if (a > cursor) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(a).toISOString() });
      cursor = Math.max(cursor, b);
    }
    if (cursor < toMsV) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(toMsV).toISOString() });
    return { scope, share: covered / length, gaps, trust: covered > 0 ? (slot?.trust ?? null) : null };
  });

  let trust: RouteTier | null = null;
  for (const s of scopes) if (s.trust) trust = weakerTier(trust, s.trust);
  return {
    completeness: scopes.length ? Math.min(...scopes.map((s) => s.share)) : 0,
    scopes,
    trust
  };
}
