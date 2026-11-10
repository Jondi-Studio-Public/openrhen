import { DEFAULT_TIMEZONE } from "../locale.js";
import { DEFAULT_LOCATION_STALE_AFTER_MINUTES } from "./context-constants.js";
import type {
  ConditionDefinition,
  ConditionMatch,
  ConditionReach,
  CurrentSituation,
  LiveHold,
  PersonHold,
  RequirementPathway,
  Truth
} from "./context-model.js";
import { resolveJourney, resolveMode, type JourneyIndex } from "./journey.js";
import { presenceHolds } from "./person-presence.js";
import { parseRequirementKey, type ParsedRequirementKey } from "./requirement-key.js";

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
  /** How this resolver reads a requirement key: the same parse, with its own definitions deciding a collision. */
  parseKey?(key: string): ParsedRequirementKey;
  /** Contact ids the owner waived for this action or step ("do it without them"), while the waiver holds. */
  waivedFor?(subjectId: string): ReadonlySet<string>;
  /** Start of the next confirmed in-person commitment with the contact, ISO, when one is known. */
  nextWithCommitmentOf?(contactId: string): string | undefined;
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
  /** `x@with`: the owner said the person is here today, or a confirmed in-person commitment with them is running. */
  | { kind: "present"; truth: Truth }
  /** `x@with` with nothing said: unknown, or no when the owner said they are away. */
  | { kind: "presence-unknown"; truth: Truth }
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
  /** The contact this commitment is with. Read only by a `x@with` requirement. */
  contactId?: string | undefined;
  /** "remote" is a call: it proves contact, not presence. Absent means in person. Read only by `x@with`. */
  attendance?: string | undefined;
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

/** Confirmed, in-person (or attendance-less) commitments with the contact; a call never counts as presence. */
function inPersonWith(contactId: string, commitments: CommitmentWindow[]): CommitmentWindow[] {
  return commitments.filter(
    (commitment) =>
      commitment.status === "confirmed" && commitment.contactId === contactId && commitment.attendance !== "remote"
  );
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

  const parseKey = (key: string): ParsedRequirementKey => parseRequirementKey(key, (id) => byId.has(id));
  const timeZone = args.timeZone;

  /** `x@with`: said by the owner and still today, or a confirmed in-person commitment with them running now. */
  const withTruth = (contactId: string): { truth: Truth; source: string } => {
    const definition = byId.get(contactId);
    if (!definition || definition.status === "archived" || definition.kind !== "contact")
      return { truth: "no", source: "undefined" };
    const said = args.situation.presence?.[contactId];
    const saidNow = said !== undefined && presenceHolds(said, args.now, timeZone);
    if (saidNow && said.state === "away") return { truth: "no", source: "overridden" };
    if (saidNow && said.state === "here") return { truth: "yes", source: "present" };
    const nowMs = args.now.getTime();
    const running = inPersonWith(contactId, args.commitments ?? []).some(
      (commitment) => new Date(commitment.startsAt).getTime() <= nowMs && nowMs < new Date(commitment.endsAt).getTime()
    );
    return running ? { truth: "yes", source: "present" } : { truth: "unknown", source: "presence-unknown" };
  };

  /** `x@remote`: today's reachable reading, spelled out so a missing channel is a refusal and not a guess. */
  const remoteTruth = (contactId: string): Truth => {
    const definition = byId.get(contactId);
    if (!definition || definition.status === "archived" || definition.kind !== "contact") return "no";
    const override = args.situation.overrides[contactId];
    if (override) return override === "available" ? "yes" : "no";
    if (definition.channels.some((channel) => channel !== "in_person")) return "yes";
    return definition.channels.length ? "no" : "unknown";
  };

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
    const parsed = parseKey(conditionId);
    if (parsed.tag === "with") {
      const { source } = withTruth(parsed.id);
      return { kind: source as "present" | "presence-unknown" | "overridden" | "undefined", truth };
    }
    if (parsed.tag === "remote") {
      const definition = byId.get(parsed.id);
      if (!definition || definition.status === "archived") return { kind: "undefined", truth };
      return args.situation.overrides[parsed.id]
        ? { kind: "overridden", truth }
        : { kind: "reachable-remotely", truth };
    }
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
    const parsed = parseKey(conditionId);
    if (parsed.tag === "with") return withTruth(parsed.id).truth;
    if (parsed.tag === "remote") return remoteTruth(parsed.id);
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
    // A tagged key names the contact it tags, so a reader looking for the name or kind finds it.
    definitionOf: (conditionId: string) => byId.get(parseKey(conditionId).id),
    parseKey,
    waivedFor: (subjectId: string) => {
      const waiver = args.situation.waivers?.[subjectId];
      const nowMs = args.now.getTime();
      const holds = waiver !== undefined && Date.parse(waiver.setAt) <= nowMs && nowMs < Date.parse(waiver.until);
      return new Set(holds ? waiver.people : []);
    },
    nextWithCommitmentOf: (contactId: string) => {
      const nowMs = args.now.getTime();
      const next = inPersonWith(contactId, args.commitments ?? [])
        .map((commitment) => new Date(commitment.startsAt).getTime())
        .filter((startMs) => startMs > nowMs)
        .sort((a, b) => a - b)[0];
      return next === undefined ? undefined : new Date(next).toISOString();
    },
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
  /** The action or step being judged, so the owner's waiver for it ("do it without them") can apply. */
  subjectId?: string;
}): ConditionMatch {
  const resolve = args.resolved.resolve;
  const waived = args.subjectId === undefined ? undefined : args.resolved.waivedFor?.(args.subjectId);
  // A waiver lifts the person-presence requirement for this work only; every other condition still has to hold.
  const pathways = waived?.size
    ? args.pathways.map((pathway) => ({
        ...pathway,
        contextIds: pathway.contextIds.filter((key) => {
          const parsed = args.resolved.parseKey?.(key) ?? parseRequirementKey(key);
          return !(parsed.tag === "with" && waived.has(parsed.id));
        })
      }))
    : args.pathways;
  const unmetPreferences = (args.preferences ?? []).filter((conditionId) => resolve(conditionId) !== "yes");
  // No stated requirements means no constraint, which is the only case where silence means yes.
  if (!pathways.length) return { status: "yes", missing: [], unknowns: [], unmetPreferences };

  const evaluated = pathways.map((pathway) => ({ pathway, ...evaluateConjunction(pathway.contextIds, resolve) }));
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
  const people = personHoldVia(best, args.resolved);
  return {
    ...match,
    ...(reach ? { reachableVia: reach } : {}),
    ...(hold ? { commitmentHold: hold } : {}),
    ...(people ? { personHold: people } : {})
  };
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

/**
 * The same "blocked by exactly this" test for people: when every thing in the way of the closest
 * pathway is a `x@with` requirement, the work is waiting on those people and the hold names them. A place
 * missing as well means the place is the reason (and the work is not here to wait for anyone), so no hold.
 * `no` is a person the owner said is away; `unknown` is nobody having said.
 */
function personHoldVia(
  entry: { pathway: RequirementPathway } & ConjunctionResult,
  resolved: ResolvedSituation
): PersonHold | undefined {
  const blockers = new Set([...entry.missing, ...entry.unknowns]);
  if (!blockers.size) return undefined;
  const people: PersonHold["people"] = [];
  for (const key of entry.pathway.contextIds) {
    if (!blockers.has(key)) continue;
    const parsed = resolved.parseKey?.(key) ?? parseRequirementKey(key);
    if (parsed.tag !== "with") return undefined;
    const name = resolved.definitionOf(parsed.id)?.name;
    if (!name) return undefined;
    if (people.some((person) => person.contactId === parsed.id)) continue;
    people.push({ contactId: parsed.id, name, state: entry.missing.includes(key) ? "no" : "unknown" });
  }
  if (!people.length) return undefined;
  const list = (items: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);
  const waiting = people.filter((person) => person.state === "unknown").map((person) => person.name);
  const away = people.filter((person) => person.state === "no").map((person) => person.name);
  const parts = [
    ...(waiting.length ? [`Waiting on ${list(waiting)}`] : []),
    ...(away.length ? [`${list(away)} ${away.length === 1 ? "is" : "are"} away`] : [])
  ];
  const availableFrom = people.length === 1 ? resolved.nextWithCommitmentOf?.(people[0]!.contactId) : undefined;
  return {
    people,
    unavailableReason: `${parts.join("; ")}.`,
    ...(availableFrom ? { availableFrom } : {})
  };
}

/**
 * Whether this work is waiting on people, whatever else is true of it: every alternative route needs someone
 * (`x@with`) and, judged on those people alone, none of the routes is met. The planner uses it to leave the work
 * out of the plan, because planning it into a window on a guess about who will be there is the thing a
 * requirement on a person exists to stop; the place is judged separately (it can be travelled to, a person cannot
 * be summoned). A route with no person in it, or a person the owner waived for this work, means it is not waiting.
 */
export function personWait(args: {
  pathways: RequirementPathway[];
  resolved: ResolvedSituation;
  subjectId?: string;
}): PersonHold | undefined {
  if (!args.pathways.length) return undefined;
  const isWith = (key: string) => (args.resolved.parseKey?.(key) ?? parseRequirementKey(key)).tag === "with";
  const peopleOnly = args.pathways.map((pathway) => ({ ...pathway, contextIds: pathway.contextIds.filter(isWith) }));
  if (peopleOnly.some((pathway) => pathway.contextIds.length === 0)) return undefined;
  const match = evaluateConditions({
    pathways: peopleOnly,
    resolved: args.resolved,
    ...(args.subjectId === undefined ? {} : { subjectId: args.subjectId })
  });
  return match.status === "yes" ? undefined : match.personHold;
}
