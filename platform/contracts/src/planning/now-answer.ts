import type { CurrentDirective, DayPlan, DayPlanBlock } from "./plan-forecast.js";
import type { PortalStateContract } from "../portal/state-schema.js";
import { buildStretchAnswer, type StretchBlock, type StretchOfferAnswer } from "./stretch.js";
import { DEFAULT_TIMEZONE, resolveLocale } from "../locale.js";
import { resolveNowActivity, type NowActivityState } from "./now-activity.js";
import {
  endsAtPause,
  openSessionTitle,
  agedInputIdsFromSchedule,
  projectHealthFromSchedule,
  resolveFreshness,
  sessionEndQuestion,
  spanLabel,
  wakeQuestion,
  type EffortAction
} from "./freshness.js";

/**
 * The one payload for "what should I do now": the directive with its why, the sleep night behind a
 * sleep directive and the step due before it, and which running anchors are open or engaged.
 *
 * The Now page, the handheld and the CLI/MCP `status` used to each derive these; `status` rebuilt the
 * answer from the wire and drifted (10-06: Now showed the pre-sleep step due, `status` said only
 * "Time to sleep"). The step now comes from `resolveNowActivity`, the same call the Now page makes,
 * and this module is the only place a directive is turned into a summary.
 */

type StoredCommitment = PortalStateContract["commitments"][number];
type StoredRoutineStep = PortalStateContract["routineSteps"][number];
type StoredSleepPlan = PortalStateContract["sleepPlans"][number];

export interface NextFitSummary {
  kind: string;
  targetId: string;
  title: string;
  recommendedMinutes: number;
  at: string;
}

export interface CandidateSummary {
  kind: string;
  targetId: string;
  title: string;
  recommendedMinutes: number;
}

export interface ThenSummary {
  kind: string;
  targetId: string;
  title: string;
  recommendedMinutes: number;
}

export interface DirectiveSummary {
  kind: string;
  title: string;
  recommendedMinutes: number;
  targetId?: string;
  reason?: string;
  tier?: string;
  projectId?: string;
  projectTitle?: string;
  toLocationId?: string;
  toLocationName?: string;
  mode?: string;
  /** Travel only: when to leave, how the figure is known (live, own, typical, fallback, estimated, assumed) and its typical length. */
  leaveBy?: string;
  travelSource?: string;
  typicalMinutes?: number;
  originAssumed?: boolean;
  /** Deadline work, or the journey to it, still inside its break: start (or leave) no earlier than this. */
  notBefore?: string;
  then?: ThenSummary;
  boundaryAt?: string;
  boundaryKind?: string;
  boundaryTitle?: string;
  boundaryEdge?: string;
  nextFit?: NextFitSummary | null;
  question?: string;
  contextIds?: string[];
  candidate?: CandidateSummary | null;
  /**
   * The night behind a sleep directive. `recommendedMinutes` alone reads as "sleep this long from
   * whenever", which an agent then measures against an alarm it was told about (observed: "540
   * minutes ... 6:45 alarm, so that's 5.5 hours" when the engine had moved the wake to 10:19 after a
   * missed start). The wake time and the engine's own reason travel with it.
   */
  sleep?: {
    startsAt: string;
    wakesAt: string;
    preferredWakeTime: string;
    explanation: string;
    replannedFromMissedStart: boolean;
    /**
     * The bedtime step actually due before sleep starts ("Brush and floss teeth"), as the Now page
     * shows it in place of the Start button. The directive stays `sleep`; this is what to do first.
     */
    currentStep?: { id: string; title: string; durationMinutes: number; status: string };
    /** The confirmed commitment that capped the wake; absent means the engine knows of none. */
    wakeConstraint?: { commitmentId: string; title?: string; protectedStartAt: string };
  };
}

/** Only the directive kinds that carry a `targetId` at all; the rest are matched to a block by kind. */
function directiveTargetId(directive: CurrentDirective): string | undefined {
  return "targetId" in directive ? directive.targetId : undefined;
}

/** `dayPlan.blocks[0]` is the live block behind the current directive, when it names the same thing. */
export function findMatchingBlock(directive: CurrentDirective, dayPlan: DayPlan | undefined): DayPlanBlock | undefined {
  const block = dayPlan?.blocks[0];
  if (!block) return undefined;
  // Work waiting out its break opens the day on the break itself, which carries the reason.
  if ("notBefore" in directive && directive.notBefore !== undefined) return block.kind === "gap" ? block : undefined;
  const targetId = directiveTargetId(directive);
  if (targetId !== undefined) return block.targetId === targetId ? block : undefined;
  return block.kind === directive.kind ? block : undefined;
}

export function buildDirectiveSummary(
  directive: CurrentDirective,
  block: DayPlanBlock | undefined,
  projectTitleById: ReadonlyMap<string, string>,
  locationNameById: ReadonlyMap<string, string>,
  sleepPlans: readonly StoredSleepPlan[] = [],
  preferredWakeTime = "",
  currentBedtimeStep?: StoredRoutineStep
): DirectiveSummary {
  const targetId = directiveTargetId(directive);
  const projectId = block?.projectId;
  const base = {
    kind: directive.kind,
    title: directive.title,
    recommendedMinutes: directive.recommendedMinutes,
    ...(targetId !== undefined ? { targetId } : {}),
    ...("notBefore" in directive && directive.notBefore !== undefined ? { notBefore: directive.notBefore } : {}),
    ...(block?.reason !== undefined ? { reason: block.reason } : {}),
    ...(block?.tier !== undefined ? { tier: block.tier } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(projectId !== undefined && projectTitleById.has(projectId)
      ? { projectTitle: projectTitleById.get(projectId) as string }
      : {})
  };
  switch (directive.kind) {
    case "travel":
      return {
        ...base,
        toLocationId: directive.toLocationId,
        toLocationName: locationNameById.get(directive.toLocationId) ?? directive.toLocationId,
        ...(directive.mode !== undefined ? { mode: directive.mode } : {}),
        ...(directive.leaveBy !== undefined ? { leaveBy: directive.leaveBy } : {}),
        travelSource: directive.source,
        ...(directive.typicalMinutes !== undefined ? { typicalMinutes: directive.typicalMinutes } : {}),
        ...(directive.originAssumed !== undefined ? { originAssumed: directive.originAssumed } : {}),
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is a domain field of the travel directive, not a promise continuation
        ...(directive.then !== undefined ? { then: directive.then } : {})
      };
    case "boundary":
      return {
        ...base,
        boundaryAt: directive.boundaryAt,
        boundaryKind: directive.boundaryKind,
        ...(directive.boundaryTitle !== undefined ? { boundaryTitle: directive.boundaryTitle } : {}),
        ...(directive.boundaryEdge !== undefined ? { boundaryEdge: directive.boundaryEdge } : {}),
        nextFit: directive.nextFit
      };
    case "sleep": {
      const night = sleepPlans.find((plan) => plan.id === directive.targetId);
      if (!night) return base;
      const step = currentBedtimeStep?.anchorId === night.id ? currentBedtimeStep : undefined;
      return {
        ...base,
        sleep: {
          startsAt: night.plannedStartAt,
          wakesAt: night.plannedWakeAt,
          preferredWakeTime,
          explanation: night.explanation,
          replannedFromMissedStart: night.replannedFromMissedStart ?? false,
          ...(step
            ? {
                currentStep: {
                  id: step.id,
                  title: step.title,
                  durationMinutes: step.durationMinutes,
                  status: step.status
                }
              }
            : {}),
          ...(night.wakeConstraint
            ? {
                wakeConstraint: {
                  commitmentId: night.wakeConstraint.commitmentId,
                  ...(night.wakeConstraint.title !== undefined ? { title: night.wakeConstraint.title } : {}),
                  protectedStartAt: night.wakeConstraint.protectedStartAt
                }
              }
            : {})
        }
      };
    }
    case "answer":
      return {
        ...base,
        question: directive.question,
        contextIds: directive.contextIds,
        candidate: directive.candidate
      };
    default:
      return base;
  }
}

export interface NowAnswerAnchors {
  /** Running anchors you are at with no engagement session against them: work is on offer ("I'm free"). */
  open: string[];
  /** Running anchors with a session against them; finishing that session is "I'm free". */
  engaged: string[];
}

/**
 * One thing OpenRhen needs to be told, because what it was last told has aged out
 * The same list on Now, `status` and the MCP
 * result, so an agent asks the person rather than repeating a stale answer.
 */
export interface Need {
  fact: "wake" | "session_end" | "energy" | "location" | "date" | "effort";
  /** The session, place, project, deliverable or action the question is about. */
  subjectId?: string;
  /** What it is about, as the person knows it: "Lab 7: VLAN trunking notes". */
  title: string;
  question: string;
  /** When OpenRhen was last told; absent when it never recorded when. */
  asOf?: string;
  /** True when the directive below would change once answered (always for `session_end`). */
  blocksDirective: boolean;
  /** How to settle it, never prose to parse. */
  answer: {
    tool: string;
    /**
     * A label for the CLI renderer and older readers, NOT an argument: on `rhen_session` and
     * `rhen_activity` the verb is `subcommand`, and `action` there names the action to work on.
     * Send `call.arguments` instead.
     */
    action: string;
    /** What the person has to supply; none when the answer is only to confirm (finishing a paused session). */
    fields: string[];
    cli: string;
    /**
     * The exact MCP call: `tool` and `arguments` as the tool's input schema spells them. Every value written
     * `<like this>` is a placeholder to replace with a real value; every other value is sent as written.
     */
    call: { tool: string; arguments: Record<string, unknown> };
    /** The rule an agent would otherwise get wrong, in words; present where there is one (session end, energy). */
    instructions?: string;
  };
}

export interface NowAnswer {
  directive: DirectiveSummary | null;
  /** Every running anchor, not the first: overlapping classes must not hide one another. */
  anchors: NowAnswerAnchors;
  /** What has gone stale, blocking needs first. Empty when every fact is current. */
  needs: Need[];
  /** A stretch on offer now (the energy cut is waived for this action if the person says yes), or null. */
  stretchOffer: StretchOfferAnswer | null;
  /** The running stretch, today's count and the morning-after loan line; null when there is nothing to say. */
  stretch: StretchBlock | null;
}

/** The most aged-effort questions Now raises at once, so a long backlog of old estimates cannot flood it. */
export const MAX_EFFORT_NEEDS = 3;

export interface NowAnswerInput {
  state: NowActivityState & {
    projects: ReadonlyArray<{ id: string; title: string }>;
    settings: {
      preferredWakeTime: string;
      maxAwakeHours: number;
      lastWokeAt?: string | undefined;
      timezone?: string | undefined;
      locale?: string | undefined;
    };
    currentEnergy?: string;
    /**
     * Names the open session when it carries no title of its own. With `remainingSetAt` and the stored plan's
     * `schedule` below, it also dates the remaining-effort estimates (`effort` needs).
     */
    actions?: ReadonlyArray<Pick<EffortAction, "id" | "title"> & Partial<EffortAction>>;
  };
  currentDirective: CurrentDirective | null | undefined;
  dayPlan?: DayPlan | undefined;
  /** The engine's stored recommendation, opaque on the wire; only its protected commitment is read. */
  recommendation?: unknown;
  /**
   * The engine's stored schedule, opaque on the wire; only each project's forecast `health` is read, to tell
   * which projects are at risk. Absent means no effort need is raised.
   */
  schedule?: unknown;
  /** When the stored plan was calculated and whether it is still current; both default to "no objection". */
  planCalculatedAt?: string | undefined;
  planCurrent?: boolean | undefined;
  now: Date;
}

function protectedFrom(recommendation: unknown): { id: string; late?: boolean } | undefined {
  const value = (recommendation as { protectedCommitment?: { id?: unknown; late?: unknown } } | null | undefined)
    ?.protectedCommitment;
  return value && typeof value.id === "string" ? { id: value.id, late: value.late === true } : undefined;
}

/**
 * Running anchors by id. An anchor is open once you are there (arrival asserted for a located one,
 * before-phase steps done for a place-less one) and no session is engaged with it — the engine's own
 * lateness test, over what the wire carries.
 */
export function runningAnchors(state: NowActivityState, now: Date): NowAnswerAnchors {
  const session = state.activeSession;
  const running = session && (session.status === "running" || session.status === "paused");
  const answer: NowAnswerAnchors = { open: [], engaged: [] };
  for (const commitment of state.commitments as StoredCommitment[]) {
    if (commitment.status === "cancelled" || commitment.presence !== "anchor") continue;
    if (!(new Date(commitment.startsAt) <= now && now < new Date(commitment.endsAt))) continue;
    if (running && session.targetType === "fixed_commitment" && session.targetId === commitment.id) {
      answer.engaged.push(commitment.id);
      continue;
    }
    const there = commitment.locationId
      ? state.currentSituation.locationId === commitment.locationId
      : !state.routineSteps.some(
          (step) =>
            step.commitmentId === commitment.id &&
            step.phase === "before" &&
            ["pending", "doing", "blocked"].includes(step.status)
        );
    if (there) answer.open.push(commitment.id);
  }
  return answer;
}

/** An action list narrowed to what the effort rule reads; the rest of a needs-only caller's actions are `{ id, title }`. */
function effortActions(actions: NowAnswerInput["state"]["actions"]): EffortAction[] | undefined {
  return actions?.flatMap((action) =>
    action.projectId !== undefined && action.status !== undefined && action.remainingMinutes !== undefined
      ? [
          {
            id: action.id,
            title: action.title,
            projectId: action.projectId,
            status: action.status,
            remainingMinutes: action.remainingMinutes,
            remainingSetAt: action.remainingSetAt,
            schedulingMode: action.schedulingMode
          }
        ]
      : []
  );
}

/** An id as one word of a command line: bare when it is plain, JSON-quoted otherwise. */
function commandWord(value: string): string {
  return /^[\w.:-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * The needs behind the freshness rule plus the one unanswered-context question that is a location
 * (the `answer` directive's own, kept verbatim so the two cannot word it differently). Blocking needs
 * come first. Only energy can be asked about with no `asOf`: a location or wake that was never told is not
 * stale, there being nothing old to distrust. Effort needs come last among the non-blocking ones: up to
 * `MAX_EFFORT_NEEDS` open actions the stored plan's forecast aged (on its at-risk projects), whose remaining time
 * was last set 14 days ago or more.
 */
export function buildNeeds(input: NowAnswerInput, locationNameById: ReadonlyMap<string, string>): Need[] {
  const { state, currentDirective, now } = input;
  const freshness = resolveFreshness({ ...state, actions: effortActions(state.actions) }, now, {
    projectHealth: projectHealthFromSchedule(input.schedule),
    agedActionIds: agedInputIdsFromSchedule(input.schedule)
  });
  const needs: Need[] = [];

  const session = state.activeSession;
  if (session && freshness.session.stale && freshness.session.asOf) {
    // An action is finished through its session; every other target through the activity command.
    const command = !session.targetType || session.targetType === "action" ? "session" : "activity";
    // A paused session already ended at its pause, and the server refuses it a later end
    // (`resolveRetroactiveEnd`): it is finished as it stands.
    const paused = endsAtPause(session);
    needs.push({
      fact: "session_end",
      subjectId: session.id,
      title: openSessionTitle(session, state.actions),
      question: sessionEndQuestion(session, now),
      asOf: freshness.session.asOf,
      blocksDirective: true,
      answer: {
        tool: `rhen_${command}`,
        action: "finish",
        fields: paused ? [] : ["endedAt"],
        cli: `rhen ${command} finish${paused ? "" : " --ended-at <time>"}`,
        call: {
          tool: `rhen_${command}`,
          arguments: paused
            ? { subcommand: "finish" }
            : { subcommand: "finish", "ended-at": "<ISO time with owner's offset>" }
        },
        instructions: paused
          ? 'Send {"subcommand":"finish"} only: it ended at its pause, and a later end time is refused.'
          : 'Ask when it stopped, then send {"subcommand":"finish","ended-at":<ISO time>}. The verb is "subcommand"; "action" names an action to work on.'
      }
    });
  }

  const locationId = state.currentSituation.locationId;
  if (locationId && freshness.location.stale && freshness.location.asOf) {
    const name = locationNameById.get(locationId) ?? locationId;
    // Borrowed only when the directive asks about this same place: asked "Are you at Home?" while the
    // stale place is Work, answering `arrive "Work"` would assert the wrong one.
    const asksLocation = currentDirective?.kind === "answer" && currentDirective.contextIds.includes(locationId);
    needs.push({
      fact: "location",
      subjectId: locationId,
      title: name,
      question: asksLocation ? currentDirective.question : `Still at ${name}?`,
      asOf: freshness.location.asOf,
      blocksDirective: asksLocation,
      answer: {
        tool: "rhen_arrive",
        action: "arrive",
        fields: ["place"],
        cli: `rhen arrive ${JSON.stringify(name)}`,
        call: { tool: "rhen_arrive", arguments: { place: name } }
      }
    });
  }

  if (freshness.wake.stale && freshness.wake.asOf) {
    needs.push({
      fact: "wake",
      title: "Last wake",
      question: wakeQuestion(freshness.wake.asOf, now),
      asOf: freshness.wake.asOf,
      blocksDirective: false,
      answer: {
        tool: "rhen_wake",
        action: "wake",
        fields: ["at"],
        cli: "rhen wake --at <time>",
        call: { tool: "rhen_wake", arguments: { at: "<ISO time with owner's offset>" } }
      }
    });
  }

  if (freshness.energy.stale) {
    const asOf = freshness.energy.asOf;
    needs.push({
      fact: "energy",
      title: "Energy",
      question: asOf
        ? `You said ${state.currentEnergy ?? "an"} energy ${spanLabel(now.getTime() - new Date(asOf).getTime())} ago. How is it now?`
        : "How is your energy now?",
      ...(asOf ? { asOf } : {}),
      blocksDirective: false,
      answer: {
        tool: "rhen_save",
        action: "current_availability",
        fields: ["currentEnergy"],
        cli: "rhen save current_availability --set currentEnergy=<high|medium|low|recovery>",
        call: {
          tool: "rhen_save",
          arguments: {
            entityType: "current_availability",
            fields: { currentEnergy: "<high|medium|low|recovery>" },
            basis: "stated",
            evidence: "<owner's words>"
          }
        },
        instructions: "Send energy only if the owner said it (never infer it); quote them in evidence."
      }
    });
  }

  // Effort stays a number the plan keeps using, so an old estimate only asks, and only about the few that
  // matter most: the list is already worst project first, oldest estimate first.
  for (const item of freshness.effort.filter((entry) => entry.stale).slice(0, MAX_EFFORT_NEEDS)) {
    needs.push({
      fact: "effort",
      subjectId: item.actionId,
      title: item.title,
      question: `Still about ${spanLabel(item.remainingMinutes * 60_000)} left on ${item.title}? Last set ${spanLabel(now.getTime() - new Date(item.asOf).getTime())} ago.`,
      asOf: item.asOf,
      blocksDirective: false,
      answer: {
        tool: "rhen_save",
        action: "action",
        fields: ["remainingMinutes"],
        cli: `rhen save action --id ${commandWord(item.actionId)} --set remainingMinutes=<minutes>`,
        call: {
          tool: "rhen_save",
          arguments: {
            entityType: "action",
            id: item.actionId,
            fields: { remainingMinutes: "<minutes>" }
          }
        }
      }
    });
  }

  // Blocking first, then the order above; a stable sort keeps that order within each group.
  return needs.sort((a, b) => Number(b.blocksDirective) - Number(a.blocksDirective));
}

export function buildNowAnswer(input: NowAnswerInput, locationNameById: ReadonlyMap<string, string>): NowAnswer {
  const { state, currentDirective, dayPlan, now } = input;
  const brain = resolveNowActivity({
    state,
    now,
    currentDirective: currentDirective ?? null,
    protectedCommitment: protectedFrom(input.recommendation),
    primary: undefined
  });
  const projectTitleById = new Map(state.projects.map((project) => [project.id, project.title]));
  const directive = currentDirective
    ? buildDirectiveSummary(
        currentDirective,
        findMatchingBlock(currentDirective, dayPlan),
        projectTitleById,
        locationNameById,
        state.sleepPlans,
        input.state.settings.preferredWakeTime,
        brain.currentBedtimeStep
      )
    : null;
  return {
    directive,
    anchors: runningAnchors(state, now),
    needs: buildNeeds(input, locationNameById),
    ...buildStretchAnswer({
      recommendation: input.recommendation,
      stretch: state.currentSituation.stretch,
      energySetAt: state.currentSituation.energySetAt,
      planCalculatedAt: input.planCalculatedAt,
      planCurrent: input.planCurrent,
      now,
      timeZone: state.settings.timezone || DEFAULT_TIMEZONE,
      locale: resolveLocale(state.settings.locale)
    })
  };
}
