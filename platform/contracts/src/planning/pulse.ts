/**
 * one owner for the pulse.
 *
 * The glossary (`CONTEXT.md`, **Pulse**) defines it as: whether the person is on plan or off plan
 * right now; on plan, what they are doing — a commitment, a deliverable, a step, an action, sleep —
 * and when it was last confirmed; off plan, since when. Nothing more.
 *
 * Before this module, three places worked out "what is the person doing" on their own:
 * `platform/contracts/src/planning/now-activity.ts`'s precedence chain (the Now page and the handheld device),
 * `platform/database/src/planning/check-in-scheduler.ts`'s `deriveBeliefSnapshot`, and
 * `tools/cli/src/commands/status.ts`. Only the first and third are swapped to read `doing` from here
 * in v1 — `check-in-scheduler.ts`'s belief carries kinds (`routine_instance`, `protected_commitment`,
 * `open_anchor`, `travel`) and fields (`phase`, `toLocationId`) `Pulse.doing` cannot express, so it is
 * left reading its own richer belief.
 *
 * `resolvePulse` is the precedence chain from `now-activity.ts:73–104`
 * (session > travel > routine step > commitment > sleep > recommended action > nothing), restated
 * over plain candidates instead of the portal-specific state (`StoredRoutineStep`, `StoredCommitment`,
 * `resolveSituation`'s inputs) that decides *which* candidate is currently in play — that eligibility
 * logic stays where its inputs live, because `check-structure.mjs` forbids this package's consumers
 * from feeding their own product types back in here. A caller resolves its candidates exactly as it
 * always did, then hands the ones that currently apply to this function, which owns only the final
 * ranking and the mapping onto the glossary's five `doing` nouns.
 */

/** The glossary's five things a person can be doing while on plan. Nothing else qualifies. */
export type PulseDoingKind = "commitment" | "deliverable" | "step" | "action" | "sleep";

/**
 * Whether the person is on plan or off plan right now, what they are doing, and when that was last
 * confirmed. `onPlan` and `offPlanSince` are declared here but never filled by `resolvePulse` — the
 * criteria for on/off are not yet designed (follow-up note). Leaving them `undefined` is
 * deliberate: a guessed value here would be a fourth disagreeing reading, the exact thing this module
 * exists to retire.
 */
export interface Pulse {
  onPlan?: boolean;
  doing?: { kind: PulseDoingKind; id: string; title: string };
  lastConfirmedAt?: string;
  offPlanSince?: string;
}

/**
 * The six session target types the wire schema knows (`activeSessionSchema.targetType`,
 * `platform/contracts/src/portal/state-schema.ts`). Named here only because `resolvePulse` maps it;
 * the schema itself stays the source of truth.
 */
export type PulseSessionTargetType =
  "action" | "routine_step" | "routine_instance" | "sleep" | "fixed_commitment" | "deliverable";

/**
 * How a session's own target type maps onto a `doing` noun. `routine_instance` is deliberately
 * absent (→ no `doing`): the glossary's `step` is "one timed part of a routine," and a
 * `routine_instance` session names the routine as a whole, not one step — there is no sixth noun for
 * it. Exported because `tools/cli/src/commands/status.ts` needs the same mapping and may only import
 * `@openrhen/contracts`.
 */
export const PULSE_SESSION_DOING_KIND: Partial<Record<PulseSessionTargetType, PulseDoingKind>> = {
  action: "action",
  deliverable: "deliverable",
  routine_step: "step",
  fixed_commitment: "commitment",
  sleep: "sleep"
};

export interface PulseCandidate {
  id: string;
  title: string;
}

export interface ResolvePulseInput {
  /** An active session claims the clock outright, whatever else is true — the caller passes it only
      while the session is actually running or paused, mirroring `now-activity.ts`'s own
      `isSessionActive` test, which this function does not repeat. */
  session?: ({ targetType: PulseSessionTargetType } & PulseCandidate) | undefined;
  /** A directed travel leg comes next, ahead of everything below it. It never names a `doing` noun —
      there is nothing to start against a leg — so only its presence matters, never its content. */
  travel?: boolean | undefined;
  /** The routine step the caller has already found due — the engine's own directive, or the in-window
      fallback `now-activity.ts` computes. */
  routineStep?: PulseCandidate | undefined;
  /** The commitment currently holding the clock, already tested for admissibility by the caller
      (`now-activity.ts`'s `protectedInfo`, or the closest a simpler caller can get to it). */
  commitment?: PulseCandidate | undefined;
  /** The night's own sleep window, once it is due. */
  sleep?: PulseCandidate | undefined;
  /** The engine's primary recommendation — the last rank before "nothing fits". */
  action?: PulseCandidate | undefined;
  /** `portal/server/persistence/postgres/readers/sessions.ts`'s `lastVerifiedAt`, passed through unchanged; see that file for how it is derived. */
  lastConfirmedAt?: string | undefined;
}

function resolveDoing(input: ResolvePulseInput): Pulse["doing"] {
  if (input.session) {
    const kind = PULSE_SESSION_DOING_KIND[input.session.targetType];
    return kind ? { kind, id: input.session.id, title: input.session.title } : undefined;
  }
  if (input.travel) return undefined;
  if (input.routineStep) return { kind: "step", ...input.routineStep };
  if (input.commitment) return { kind: "commitment", ...input.commitment };
  if (input.sleep) return { kind: "sleep", ...input.sleep };
  if (input.action) return { kind: "action", ...input.action };
  return undefined;
}

/**
 * The one place `Pulse` is built. Pure: no I/O, no clock read — every consumer passes the `now` it
 * already resolved its own candidates against. `onPlan` and `offPlanSince` are never set; see
 * `Pulse`'s own doc comment.
 */
export function resolvePulse(input: ResolvePulseInput): Pulse {
  const doing = resolveDoing(input);
  return {
    ...(doing ? { doing } : {}),
    ...(input.lastConfirmedAt !== undefined ? { lastConfirmedAt: input.lastConfirmedAt } : {})
  };
}
