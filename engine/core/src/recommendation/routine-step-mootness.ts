/**
 * The one rule for "this pre-commitment routine step is moot because the person is already at the
 * commitment's location" — findings 19/20/42. Three places used to answer this question with three
 * disagreeing implementations: the read-time check this module now backs (`selectCurrentDirective`
 * here, and its portal mirror `resolveNowActivity` in `platform/contracts/src/planning/now-activity.ts`), the arrival
 * auto-skip (`routine-step-arrival.ts`), and the periodic sweep (`routine-step-mootness.ts`,
 * platform/database). The read-time check in particular carried no time bound at all: a before-phase
 * step of a *home-located* commitment reads as moot the instant the person is home, which for most
 * people is true most of the day — so the step was excluded from ever being directed, hours before its
 * own routine block had even opened (report/finding 20), and sat undirected until the sweep eventually
 * caught up and skipped it unperformed.
 *
 * `platform/database` and `portal/*` cannot import this package (`pnpm structure:check` forbids it —
 * platform and portal are both upstream of engine-core, not downstream), so this is the canonical,
 * tested definition and the other three sites reimplement the same four rules locally, each with a
 * comment pointing back here. Keeping the rules this small and this explicit is what makes that
 * duplication tractable: any future change to the rule is four small, obviously-parallel edits rather
 * than four independent guesses.
 */

/** The least a routine step needs to carry to be judged. */
export interface RoutineStepMootnessStep {
  /** Only a `"before"` step — the preparation that leads into the commitment — is ever moot this way.
   * An `"after"` step follows the commitment and has nothing to do with having reached it. */
  phase: "before" | "after";
}

/** The least a commitment needs to carry to be judged. */
export interface RoutineStepMootnessCommitment {
  /** The place this commitment happens, or null/undefined for a commitment with no fixed place —
   * which can never be "arrived at" and so can never make a step moot. */
  locationId: string | null | undefined;
  /** The commitment's own end. Mootness never outlives it — once the commitment is over, whatever
   * remains of its preparation is a stale leftover, not "already there" for a place no longer relevant. */
  endsAt: Date;
}

/** The person's current location assertion, or null when none is currently held. */
export interface RoutineStepMootnessLocation {
  locationId: string;
  /** When the assertion was made. Missing or unparseable is treated as untrustworthy — matching the
   * sweep's own strictness (`currentFreshLocationId`, platform/database's routine-step-mootness.ts) —
   * rather than as fresh forever, since this rule *acts* on the assertion (retires a step) rather than
   * merely reporting it. */
  locationSetAt: Date | string | null | undefined;
}

export interface RoutineStepMootnessInput {
  step: RoutineStepMootnessStep;
  commitment: RoutineStepMootnessCommitment;
  /**
   * The earliest planned start among this routine instance's own before-phase steps — the moment its
   * pre-commitment block actually opens. Callers compute this once per commitment (the minimum
   * `scheduledStartAt` across its before-phase steps) and pass it in; it is not derived here because
   * each caller holds its steps in a different shape (wire steps in the engine, stored rows in the
   * portal, database rows in the sweep).
   */
  routineWindowStart: Date;
  currentLocation: RoutineStepMootnessLocation | null;
  now: Date;
  /** The same location-freshness knob every other staleness check in the system reads
   * (`DEFAULT_LOCATION_STALE_AFTER_MINUTES`, context-constants.ts, or a caller's own override). */
  staleAfterMinutes: number;
}

export type RoutineStepMootnessResult = { moot: false } | { moot: true; reason: "already_at_location" };

/**
 * `{ moot: true }` exactly when all four hold:
 *
 * 1. The step is a `"before"`-phase step — the preparation that leads into the commitment.
 * 2. The current location assertion is fresh: present, parseable, and no older than
 *    `staleAfterMinutes`.
 * 3. That fresh location is the commitment's own `locationId`.
 * 4. The instant in question falls inside the commitment's own preparation window: at or after
 *    `routineWindowStart`, and strictly before the commitment's own `endsAt`. Outside that window the
 *    step is never moot on arrival grounds, whatever the location says — this is the bound the
 *    read-time check used to be missing entirely (report/finding 20).
 */
export function routineStepMootness(input: RoutineStepMootnessInput): RoutineStepMootnessResult {
  const notMoot: RoutineStepMootnessResult = { moot: false };
  if (input.step.phase !== "before") return notMoot;
  if (!input.commitment.locationId) return notMoot;
  if (!input.currentLocation) return notMoot;

  const setAt =
    input.currentLocation.locationSetAt instanceof Date
      ? input.currentLocation.locationSetAt
      : typeof input.currentLocation.locationSetAt === "string"
        ? new Date(input.currentLocation.locationSetAt)
        : null;
  if (!setAt || Number.isNaN(setAt.getTime())) return notMoot;
  const ageMinutes = (input.now.getTime() - setAt.getTime()) / 60_000;
  if (ageMinutes > input.staleAfterMinutes) return notMoot;

  if (input.currentLocation.locationId !== input.commitment.locationId) return notMoot;

  if (input.now < input.routineWindowStart || input.now >= input.commitment.endsAt) return notMoot;

  return { moot: true, reason: "already_at_location" };
}

/** The fields of a routine step the window start reads, from the engine's wire steps or the portal's stored ones. */
interface WindowStep {
  // Optional: a sleep-anchored step carries no
  // `commitmentId` at all, and `earliestRoutineWindowStarts` skips it (a real
  // commitment id is never `undefined`) without this shape needing to require the field.
  // `| undefined` spelled out because `exactOptionalPropertyTypes` distinguishes an optional
  // property from one whose value may explicitly be `undefined`, which is what the wire schema's
  // `.optional()` output actually produces for a caller's array element.
  commitmentId?: string | undefined;
  phase: "before" | "after";
  scheduledStartAt?: Date | string | null | undefined;
}

/**
 * The earliest scheduled start among a commitment's own before-phase routine steps — the
 * `routineWindowStart` every `routineStepMootness` call needs. Structural over the caller's own step
 * shape so the engine's wire steps and the portal's stored steps can both use it without a conversion
 * layer; the platform/database sweep computes the same value directly in SQL (`MIN(scheduled_start_at)`)
 * since it never materializes steps as JS objects.
 */
export function earliestRoutineWindowStart(steps: readonly WindowStep[], commitmentId: string): Date | undefined {
  return earliestRoutineWindowStarts(steps.filter((step) => step.commitmentId === commitmentId)).get(commitmentId);
}

/**
 * `earliestRoutineWindowStart` for every commitment at once, in one pass over the steps. The directive
 * needs the value for every commitment in force and the projected day re-selects the directive at each
 * block, so asking per commitment scanned every step once per commitment per block.
 */
export function earliestRoutineWindowStarts(steps: readonly WindowStep[]): Map<string, Date> {
  const earliest = new Map<string, Date>();
  for (const step of steps) {
    if (step.commitmentId === undefined || step.phase !== "before" || !step.scheduledStartAt) continue;
    const startsAt = step.scheduledStartAt instanceof Date ? step.scheduledStartAt : new Date(step.scheduledStartAt);
    if (Number.isNaN(startsAt.getTime())) continue;
    const current = earliest.get(step.commitmentId);
    if (!current || startsAt < current) earliest.set(step.commitmentId, startsAt);
  }
  return earliest;
}
