import { DEFAULT_TIMEZONE } from "../locale.js";
import { DEFAULT_LOCATION_STALE_AFTER_MINUTES } from "./context-constants.js";
import type {
  ConditionDefinition,
  ConditionMatch,
  ConditionReach,
  CurrentSituation,
  LiveHold,
  RequirementPathway,
  Truth
} from "./context-model.js";
import { resolveJourney, resolveMode, type JourneyIndex } from "./journey.js";

/**
 * The single condition matcher. It lives in contracts rather than the engine because the portal is
 * forbidden from importing engine-core, and a second browser-side copy of this logic is exactly the
 * defect being removed.
 */
export interface ResolvedSituation {
  /** Current location after staleness expiry, or null when unknown. */
  locationId: string | null;
  /** True when a location was asserted but has aged out of being trustworthy. */
  locationStale: boolean;
  /** Composite capabilities found to be self-referential. Fills in as conditions are resolved. */
  readonly cycles: string[];
  resolve(conditionId: string): Truth;
  definitionOf(conditionId: string): ConditionDefinition | undefined;
  /** The verdict for a condition together with what produced it. */
  sourceOf?(conditionId: string): ResolutionSource;
  /** What it would cost to get to a location, or undefined when you cannot get there at all. */
  travelTo?(locationId: string): ConditionReach | undefined;
  /** Hold copy for a `live` condition that is not currently satisfied, or undefined otherwise. */
  commitmentHoldOf?(conditionId: string): LiveHold | undefined;
}

/**
 * Why a condition resolved the way it did. The page showing a capability as available has to say
 * where that came from — otherwise the person cannot tell an inference they should correct from a
 * fact they asserted. Deriving it in the UI would recreate the duplicate matcher this model exists
 * to remove, so the reason is produced by the same pass that produces the verdict.
 */
export type ResolutionSource =
  | { kind: "overridden"; truth: Truth }
  | { kind: "carried"; truth: Truth }
  | { kind: "granted"; truth: Truth; locationId: string }
  | { kind: "here"; truth: Truth }
  | { kind: "reachable-remotely"; truth: Truth }
  | { kind: "composite"; truth: Truth }
  | { kind: "live"; truth: Truth }
  | { kind: "location-unknown"; truth: Truth }
  | { kind: "undefined"; truth: Truth };

export interface ConjunctionResult {
  status: Truth;
  missing: string[];
  unknowns: string[];
}

/**
 * The commitment facts a `live` condition needs, reduced to what deciding "is it live right
 * now" takes. `FixedCommitment` (engine-core) and the portal state's own commitment records both
 * satisfy this structurally, so every caller that already has commitments in scope — for its own
 * protected-window logic — can pass them straight through with no adapter.
 */
export interface CommitmentWindow {
  id: string;
  recurrenceRuleId?: string | undefined;
  startsAt: Date | string;
  endsAt: Date | string;
  /** Only "confirmed" ever counts as active; absent, "tentative", or "cancelled" never do. */
  status?: string | undefined;
  /** Used only for hold copy ("Only during <title>"); resolution itself never reads this. */
  title?: string | undefined;
}

/**
 * Whether a `live` condition is satisfied right now: a confirmed, non-cancelled commitment
 * matching the condition's rule or one-off id, with `now` inside that commitment's own window —
 * `[startsAt, endsAt)`, never its setup, travel, or transition buffers (§ the engine's protected
 * window is a different, larger interval built for a different question). No commitment is ever
 * matched by default: a caller that has not threaded `commitments` through resolves every
 * live condition to "no", the same as a search that ran and found nothing live.
 */
function matchingCommitments(definition: ConditionDefinition, commitments: CommitmentWindow[]): CommitmentWindow[] {
  return commitments.filter((commitment) => {
    if (commitment.status !== "confirmed") return false;
    return definition.commitmentId !== undefined
      ? commitment.id === definition.commitmentId
      : definition.recurrenceRuleId !== undefined && commitment.recurrenceRuleId === definition.recurrenceRuleId;
  });
}

function commitmentConditionActive(
  definition: ConditionDefinition,
  commitments: CommitmentWindow[],
  now: Date
): boolean {
  const nowMs = now.getTime();
  return matchingCommitments(definition, commitments).some((commitment) => {
    const start = new Date(commitment.startsAt).getTime();
    const end = new Date(commitment.endsAt).getTime();
    return start <= nowMs && nowMs < end;
  });
}

/**
 * Hold copy for a `live` condition that is not live right now: which commitment it is waiting
 * on, and — cheaply, from the same `commitments` list already in hand, never a fresh lookup — the
 * next confirmed occurrence's start, when one is already known. Mirrors `travelTo`'s role for a
 * location hold: the raw fact a caller turns into a sentence, not the sentence itself.
 */
function commitmentHoldOf(
  definition: ConditionDefinition,
  commitments: CommitmentWindow[],
  now: Date
): LiveHold | undefined {
  const nowMs = now.getTime();
  const matching = matchingCommitments(definition, commitments);
  const upcoming = matching
    .filter((commitment) => new Date(commitment.startsAt).getTime() > nowMs)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const next = upcoming[0];
  // The title on the nearest known occurrence is the most concrete thing to name; falling back to
  // the condition's own name keeps this useful even when no occurrence has been generated yet (a rule
  // whose materialisation horizon has not reached this far, or a caller with no commitments to hand).
  const title = next?.title ?? definition.name;
  return {
    unavailableReason: `Only during ${title}.`,
    ...(next ? { availableFrom: new Date(next.startsAt).toISOString() } : {})
  };
}

export function resolveSituation(args: {
  situation: CurrentSituation;
  definitions: ConditionDefinition[];
  now: Date;
  staleAfterMinutes?: number;
  /** Live commitment facts for `commitment` conditions. Omit and every such condition resolves "no". */
  commitments?: CommitmentWindow[];
  /**
   * The one journey lookup. Absent for every
   * browser caller today, which keeps the stored-minutes fallback `travelTo` always had; a caller
   * that has it gets the same figures the engine's projection would compute.
   */
  journeys?: JourneyIndex;
  homeLocationId?: string;
  /** Only used alongside `journeys`, to derive the departure band. Defaults to UTC. */
  timeZone?: string;
}): ResolvedSituation {
  const byId = new Map(args.definitions.map((definition) => [definition.id, definition]));
  const staleAfter = args.staleAfterMinutes ?? DEFAULT_LOCATION_STALE_AFTER_MINUTES;
  const setAt = args.situation.locationSetAt ? new Date(args.situation.locationSetAt) : undefined;
  const ageMinutes =
    setAt && !Number.isNaN(setAt.getTime()) ? (args.now.getTime() - setAt.getTime()) / 60_000 : undefined;
  // A location asserted this morning is not evidence of where you are tonight. Expiring it to
  // unknown is recoverable; leaving it confidently wrong is not.
  const locationStale = args.situation.locationId !== null && ageMinutes !== undefined && ageMinutes > staleAfter;
  const locationId = locationStale ? null : args.situation.locationId;
  const location = locationId === null ? undefined : byId.get(locationId);

  const memo = new Map<string, Truth>();
  const stack = new Set<string>();
  const cycles = new Set<string>();

  const resolve = (conditionId: string): Truth => {
    const cached = memo.get(conditionId);
    if (cached) return cached;
    if (stack.has(conditionId)) {
      cycles.add(conditionId);
      return "no";
    }
    stack.add(conditionId);
    const result = compute(conditionId);
    stack.delete(conditionId);
    memo.set(conditionId, result);
    return result;
  };

  const travelTo = (toLocationId: string): ConditionReach | undefined => {
    // No way to travel means nothing elsewhere is reachable, full stop. This is the deliberate escape
    // hatch: unticking every mode stops the planner offering trips you cannot make.
    if (!args.situation.transportModes.length) return undefined;
    const definition = byId.get(toLocationId);
    if (!definition || definition.kind !== "location") return undefined;
    // A caller carrying the journey index (the engine's own matcher use, never a browser caller — see
    // `resolveJourney`'s doc comment) reads the same figures the projection computes, in place of the
    // old per-destination cache below.
    if (args.journeys && locationId !== null) {
      const from = byId.get(locationId);
      const mode = resolveMode({
        transportModes: args.situation.transportModes,
        journeys: args.journeys,
        from: { id: locationId, ...(from?.travelMinutes !== undefined ? { storedMinutes: from.travelMinutes } : {}) },
        to: {
          id: toLocationId,
          ...(definition.travelMinutes !== undefined ? { storedMinutes: definition.travelMinutes } : {})
        }
      });
      if (mode) {
        const journey = resolveJourney({
          journeys: args.journeys,
          from: {
            id: locationId,
            ...(from?.latitude !== undefined ? { latitude: from.latitude } : {}),
            ...(from?.longitude !== undefined ? { longitude: from.longitude } : {}),
            ...(from?.travelMinutes !== undefined ? { storedMinutes: from.travelMinutes } : {})
          },
          to: {
            id: toLocationId,
            ...(definition.latitude !== undefined ? { latitude: definition.latitude } : {}),
            ...(definition.longitude !== undefined ? { longitude: definition.longitude } : {}),
            ...(definition.travelMinutes !== undefined ? { storedMinutes: definition.travelMinutes } : {})
          },
          mode,
          departAt: args.now,
          now: args.now,
          timeZone: args.timeZone ?? DEFAULT_TIMEZONE,
          caution: "normal",
          ...(args.homeLocationId ? { homeLocationId: args.homeLocationId } : {})
        });
        if (journey) return { locationId: toLocationId, travelMinutes: journey.minutes, mode: journey.mode };
      }
    }
    // A measured journey knows how you can actually travel today, so it beats the stored fallback —
    // but only while its mode is still one you have.
    const measured = args.situation.travel[toLocationId];
    if (measured && args.situation.transportModes.includes(measured.mode)) {
      return { locationId: toLocationId, travelMinutes: measured.minutes, mode: measured.mode };
    }
    if (definition.travelMinutes === undefined) return undefined;
    return { locationId: toLocationId, travelMinutes: definition.travelMinutes };
  };

  const sourceOf = (conditionId: string): ResolutionSource => {
    const truth = resolve(conditionId);
    const definition = byId.get(conditionId);
    if (!definition || definition.status === "archived") return { kind: "undefined", truth };
    if (args.situation.overrides[conditionId]) return { kind: "overridden", truth };
    if (definition.kind === "location") return { kind: "here", truth };
    if (definition.kind === "capability" && definition.pathways.length) return { kind: "composite", truth };
    if (definition.kind === "capability" && definition.portability === "portable") return { kind: "carried", truth };
    if (definition.kind === "contact" && definition.channels.some((channel) => channel !== "in_person"))
      return { kind: "reachable-remotely", truth };
    if (definition.kind === "live") return { kind: "live", truth };
    if (!location) return { kind: "location-unknown", truth };
    return { kind: "granted", truth, locationId: location.id };
  };

  const compute = (conditionId: string): Truth => {
    const definition = byId.get(conditionId);
    // An undefined or archived condition fails closed. Reporting it as unknown would raise a question
    // with no answerable subject; as a miss it at least names what is wrong.
    if (!definition || definition.status === "archived") return "no";

    const override = args.situation.overrides[conditionId];
    if (override) return override === "available" ? "yes" : "no";

    if (definition.kind === "location") {
      if (locationId === null) return "unknown";
      return locationId === conditionId ? "yes" : "no";
    }

    if (definition.kind === "capability") {
      // Composites derive from their pathways, so portability does not apply to them.
      if (definition.pathways.length) return anySatisfied(definition.pathways, resolve);
      if (definition.portability === "portable") {
        const carried = args.situation.carrying[conditionId];
        return carried === undefined ? "unknown" : carried ? "yes" : "no";
      }
    }

    if (definition.kind === "contact") {
      // Reaching someone by message or call does not depend on where you are, so only a strictly
      // in-person contact is location-gated. A contact with no channel at all says nothing about how
      // to reach them, which is a question rather than a refusal.
      if (!definition.channels.length) return "unknown";
      if (definition.channels.some((channel) => channel !== "in_person")) return "yes";
    }

    // A live condition answers a question the clock alone settles: is now inside a live,
    // confirmed occurrence of the named rule or one-off. Never "unknown" — no situation makes this
    // unanswerable, only true or false — and never inferred from location, which is a different fact.
    if (definition.kind === "live") {
      return commitmentConditionActive(definition, args.commitments ?? [], args.now) ? "yes" : "no";
    }

    // Fixed capabilities and in-person contacts are inferred from where you are.
    if (!location) return "unknown";
    return location.grants.includes(conditionId) ? "yes" : "no";
  };

  return {
    locationId,
    locationStale,
    get cycles() {
      return [...cycles].sort();
    },
    resolve,
    definitionOf: (conditionId: string) => byId.get(conditionId),
    sourceOf,
    travelTo,
    commitmentHoldOf: (conditionId: string) => {
      const definition = byId.get(conditionId);
      if (!definition || definition.kind !== "live") return undefined;
      return commitmentHoldOf(definition, args.commitments ?? [], args.now);
    }
  };
}

export function evaluateConditions(args: {
  pathways: RequirementPathway[];
  preferences?: string[];
  resolved: ResolvedSituation;
}): ConditionMatch {
  const resolve = args.resolved.resolve;
  const unmetPreferences = (args.preferences ?? []).filter((conditionId) => resolve(conditionId) !== "yes");
  // No stated requirements means no constraint, which is the only case where silence means yes.
  if (!args.pathways.length) return { status: "yes", missing: [], unknowns: [], unmetPreferences };

  const evaluated = args.pathways.map((pathway) => ({ pathway, ...evaluateConjunction(pathway.contextIds, resolve) }));
  const satisfied = evaluated.find((entry) => entry.status === "yes");
  if (satisfied) {
    return { status: "yes", satisfiedPathwayId: satisfied.pathway.id, missing: [], unknowns: [], unmetPreferences };
  }

  // Report against the closest pathway so the reason given is the most actionable one, rather than
  // whichever route happened to be authored first.
  const undetermined = evaluated.filter((entry) => entry.status === "unknown");
  const best = [...(undetermined.length ? undetermined : evaluated)].sort(byCloseness)[0]!;
  const match: ConditionMatch = {
    status: undetermined.length ? "unknown" : "no",
    missing: best.missing,
    unknowns: best.unknowns,
    unmetPreferences
  };
  const reach = reachableVia(best, args.resolved);
  const hold = commitmentHoldVia(best, args.resolved);
  return { ...match, ...(reach ? { reachableVia: reach } : {}), ...(hold ? { commitmentHold: hold } : {}) };
}

export function evaluateConjunction(contextIds: string[], resolve: (conditionId: string) => Truth): ConjunctionResult {
  const missing: string[] = [];
  const unknowns: string[] = [];
  for (const conditionId of contextIds) {
    const truth = resolve(conditionId);
    if (truth === "no") missing.push(conditionId);
    else if (truth === "unknown") unknowns.push(conditionId);
  }
  return { status: missing.length ? "no" : unknowns.length ? "unknown" : "yes", missing, unknowns };
}

/** Static cycle detection over composite capabilities, independent of any current situation. */
export function findCompositeCycles(definitions: ConditionDefinition[]): string[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const state = new Map<string, "visiting" | "done">();
  const cycles = new Set<string>();
  const visit = (conditionId: string) => {
    const seen = state.get(conditionId);
    if (seen === "done") return;
    if (seen === "visiting") {
      cycles.add(conditionId);
      return;
    }
    state.set(conditionId, "visiting");
    for (const pathway of byId.get(conditionId)?.pathways ?? []) for (const next of pathway) visit(next);
    state.set(conditionId, "done");
  };
  for (const definition of definitions) visit(definition.id);
  return [...cycles].sort();
}

function anySatisfied(pathways: string[][], resolve: (conditionId: string) => Truth): Truth {
  let undetermined = false;
  for (const contextIds of pathways) {
    const { status } = evaluateConjunction(contextIds, resolve);
    if (status === "yes") return "yes";
    if (status === "unknown") undetermined = true;
  }
  return undetermined ? "unknown" : "no";
}

/**
 * Fewest known misses first, then fewest open questions. Entries in the undetermined group all have
 * no misses, so this single ordering serves both groups.
 */
function byCloseness(
  a: { pathway: RequirementPathway } & ConjunctionResult,
  b: { pathway: RequirementPathway } & ConjunctionResult
) {
  return (
    a.missing.length - b.missing.length ||
    a.unknowns.length - b.unknowns.length ||
    a.pathway.id.localeCompare(b.pathway.id)
  );
}

/**
 * Executable versus initiable: a pathway blocked only by being somewhere else is not impossible,
 * it is a trip. Open questions disqualify the signal, because travelling on an unverified guess is
 * a worse outcome than asking.
 */
function reachableVia(entry: ConjunctionResult, resolved: ResolvedSituation): ConditionReach | undefined {
  if (entry.unknowns.length || entry.missing.length !== 1) return undefined;
  const definition = resolved.definitionOf(entry.missing[0]!);
  if (!definition || definition.kind !== "location") return undefined;
  return resolved.travelTo?.(definition.id);
}

/**
 * The same "blocked by exactly one thing" test as `reachableVia`, for a commitment instead of a
 * place: a pathway missing only a live occurrence of a named commitment is not impossible, it is a
 * wait, and the hold names what for.
 */
function commitmentHoldVia(entry: ConjunctionResult, resolved: ResolvedSituation): LiveHold | undefined {
  if (entry.unknowns.length || entry.missing.length !== 1) return undefined;
  const definition = resolved.definitionOf(entry.missing[0]!);
  if (!definition || definition.kind !== "live") return undefined;
  return resolved.commitmentHoldOf?.(definition.id);
}
