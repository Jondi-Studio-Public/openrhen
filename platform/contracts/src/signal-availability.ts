/**
 * Source-availability contracts: the vocabularies and shapes a source's route declares (what it observes, through
 * which vantage point, how fresh and how far to trust it) and the evidence a reader hands to fusion. Types and constants
 * only: no functions, no database access, no I/O. The pure rules (`classifySource`, `fuseState`, `fuseLedger`) live
 * in `signal-fusion.ts` and `signal-anchors.ts` and import from here. Nothing in the engine, the pulse or the scheduler reads this file.
 * See the new-data-sources design, sections 2.1 and 2.4, and 14 for the room-posture fields.
 */

/** The signals a source can supply. Every vocabulary below is frozen. */
export const SIGNAL_NAMES = Object.freeze([
  "position",
  "motion_state",
  "presence_home",
  "spend",
  "device_attention",
  "web_activity",
  "weather",
  "travel_time",
  "vehicle"
] as const);
export type SignalName = (typeof SIGNAL_NAMES)[number];

/** How a route delivers: `inferred` is a route read out of other evidence rather than sensed or imported. */
export const ROUTE_TIERS = Object.freeze(["live", "periodic", "import", "inferred"] as const);
export type RouteTier = (typeof ROUTE_TIERS)[number];

/** The vantage point a route observes through; routes that share an origin are correlated. */
export const ORIGINS = Object.freeze([
  "phone",
  "computer",
  "home_net",
  "home_hub",
  "vehicle",
  "account",
  "files",
  "cloud"
] as const);
export type Origin = (typeof ORIGINS)[number];

/** The values `motion_state` takes. */
export const MOTION_STATES = Object.freeze([
  "stationary",
  "walking",
  "running",
  "cycling",
  "automotive",
  "unknown"
] as const);
export type MotionState = (typeof MOTION_STATES)[number];

/** The values `presence_home` takes. There is no `asleep`: sleep never feeds capacity. */
export const PRESENCE_VALUES = Object.freeze(["home", "away"] as const);
export type PresenceValue = (typeof PRESENCE_VALUES)[number];

/** The most confidence a route of each tier can ever carry, applied to weights at read time too. All are at most 0.95. */
export const TIER_CEILING: Readonly<Record<RouteTier, number>> = Object.freeze({
  live: 0.8,
  periodic: 0.7,
  import: 0.6,
  inferred: 0.4
});

/**
 * What a fusion slot is keyed by: `origin` (default), `device` (`<origin>:<device>`), or `route`
 * (`<origin>:<device>:<attrs.label>`, so two sensors on one device stay independent).
 */
export const SLOT_BY = Object.freeze(["origin", "device", "route"] as const);
export type SlotBy = (typeof SLOT_BY)[number];

/**
 * How an item's freshness is computed. `decay` is f = 0.5^(age/halfLife), 0 past the max age.
 * `refreshed-held` is f = 1 while the same (route, state) was re-posted within `staleAfterMinutes`, else 0; it never
 * rises with age.
 */
export const FRESHNESS_MODES = Object.freeze(["decay", "refreshed-held"] as const);
export type FreshnessMode = (typeof FRESHNESS_MODES)[number];

export interface SignalHold {
  /** Kinds that close the held state, from any route of the same origin. */
  closedBy: readonly string[];
  /** Decay half-life while held, in minutes. `Infinity` means the state does not decay (f = 1). */
  halfLifeMinutes: number;
  /** Past this age the held state is not evidence. `Infinity` means it never expires. */
  maxMinutes: number;
}

/** What one kind of one source contributes to one signal. */
export interface SignalFeed {
  signal: SignalName;
  tier: RouteTier;
  kinds: readonly string[];
  /** Slot key for fusion; default `origin`. */
  slotBy?: SlotBy;
  /** The kind may carry absence coverage (room-posture). */
  absence?: boolean;
  /** 0..1; clamped to `TIER_CEILING[tier]` at read time too, so an extension source cannot exceed it. */
  weight: number;
  /** Freshness mode; default `decay`. */
  freshness?: FreshnessMode;
  /** For `refreshed-held`: how long after a re-post the state still counts, in minutes. Required with that mode. */
  staleAfterMinutes?: number;
  /** A state-change kind holds until a closing kind from any route of the same origin, or a fresher opposite value. */
  holds?: SignalHold;
  /** A ledger signal: coverage comes only from `coverage` rows and import extents on this source. */
  complete?: boolean;
}

export interface SourceAvailability {
  delivery: "live" | "periodic" | "import";
  origin: Origin;
  expectedEveryMinutes?: number;
  /** Default 3 x `expectedEveryMinutes`. */
  silentAfterMinutes?: number;
  /** A source may narrow a family's weights, never raise them. */
  feeds: readonly SignalFeed[];
  coverageGroup?: string;
  /** One plain line naming the exact next step when the source is silent or errored. */
  recoveryHint: string;
}

/**
 * Where something is. An open tagged union: each member is registered in `AnchorKinds`, and a later feature adds
 * its own by merging into that interface (for example `node: { path: string }`). Precedence when several resolve is
 * cond, then place, then cell.
 */
export interface AnchorKinds {
  /** A known place: a `condition_definitions` id. */
  cond: { id: string };
  /** A discovered place id. */
  place: { id: string };
  /** A geohash-7 cell (about 150 m). */
  cell: { gh7: string };
  /** A node below a site, such as a room; other families may add their own members beside it. */
  node: { site: string; path: string };
}
export type Anchor = { [K in keyof AnchorKinds]: { t: K } & AnchorKinds[K] }[keyof AnchorKinds];

/**
 * Whose presence a row records. Defaults to `self` for every family. `other` is a pet or known noise and is
 * excluded from the owner.
 */
export const EVIDENCE_SUBJECTS = Object.freeze(["self", "anyone", "other"] as const);
export type EvidenceSubject = (typeof EVIDENCE_SUBJECTS)[number];

/** One row mapped to evidence. Times are RFC 3339 strings. */
export interface EvidenceItem {
  source: string;
  origin: Origin;
  signal: SignalName;
  value: unknown;
  observedAt: string;
  /** When the store took the row, so a caller can build a live or settled view by filtering on it. */
  ingestedAt: string;
  tier: RouteTier;
  weight: number;
  /** Fusion ignores it; the item mapping drops items it should not count. Absent means `self`. */
  subject?: EvidenceSubject;
}
