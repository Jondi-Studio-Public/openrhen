/**
 * The data health check, `doctor`: pure, deterministic checks over a plain
 * snapshot of the plan, with no database and no model. It reads facts other modules already own
 * (`resolveFreshness`, the catch-up and finding counts) and adds the checks nothing else makes. It
 * changes no row; every `fix` names a command that already exists.
 */
import type { ProcessingReport } from "../data-flow/coverage.js";
import { cadenceItems, type DoctorCadenceSlice } from "./doctor-cadence.js";
import { duplicateItems, type DoctorDuplicatesSlice } from "./doctor-duplicates.js";
import { closedStampItems, type DoctorClosedSlice } from "./doctor-closed.js";
import { recordingItems, type DoctorRecordingSlice } from "./doctor-recording.js";
import { doctorPeopleItems, type DoctorPeopleSlice } from "./doctor-people.js";
import { prerequisiteItems, type DoctorPrerequisitesSlice } from "./doctor-prerequisites.js";
import { publishingItems, type DoctorPublishingSlice } from "./doctor-publishing.js";
import {
  DOCTOR_SOURCE_CHECKS,
  planInputs,
  sourceItems,
  type DoctorSourceCounts,
  type PlanInputs,
  type DoctorSourcesSlice
} from "./doctor-sources.js";
import type { Freshness } from "./freshness.js";

export const DOCTOR_TIERS = ["blocking", "degrading", "tidy"] as const;
export type DoctorTier = (typeof DOCTOR_TIERS)[number];

export const DOCTOR_AREAS = ["facts", "integrations", "calendar", "plan", "routines", "staleness", "ledgers"] as const;
export type DoctorArea = (typeof DOCTOR_AREAS)[number];

/** Starting thresholds, in one place so a wrong one is a one-line change (the owner can change them). */
export const DOCTOR_THRESHOLDS = {
  /** A sync that has not succeeded for this long is blocking. */
  syncFailingHours: 24,
  /** An event held for review this long, or a commitment needing detail this near, is blocking. */
  heldEventDays: 3,
  /** A commitment starting inside this many days with no place or travel mode needs it now. */
  commitmentDetailDays: 7,
  /** A recurring action or cadence untouched for this many intervals has lapsed. */
  routineLapsedIntervals: 3,
  /** Active work not touched for this many days is asked about (Keep, Pause or Drop). */
  idleDays: 30,
  /** A proposal waiting this long is tidy-tier noise. */
  proposalWaitingDays: 14,
  /** Items sort ahead of the rest when the date they are tied to falls inside this many days. */
  soonDays: 7
} as const;

/** A project kept (reviewed) this recently is not asked about, whatever its last work. */
export const DOCTOR_KEEP_FOR_DAYS = 30;

/** Every check name a doctor item can carry; `DoctorItem.check` is one of these. */
export const DOCTOR_CHECKS = [
  "stale_wake",
  "stale_session",
  "stale_location",
  "stale_energy",
  "pulse_off",
  "sync_failing",
  "diff_profile_unregistered",
  "event_held",
  "commitment_detail",
  "no_estimate",
  "aged_estimate",
  "nothing_to_do",
  "deadline_passed",
  "idle_project",
  "routine_ended",
  "routine_lapsed",
  "review_overdue",
  "proposal_waiting",
  "catch_up_unsettled",
  "open_findings",
  "cadence_overdue",
  "routine_missed",
  "sync_late",
  "duplicate_action",
  "duplicate_proposal",
  "link_to_finished",
  "unmet_prerequisite",
  "person_waiting_deadline",
  "requirement_unresolvable",
  "prerequisite_cycle",
  "blocker_no_person",
  "empty_assessment",
  "calendar_publish_failing",
  "calendar_remote_missing",
  "push_failing",
  "pulse_publish_failing",
  "backup_never",
  "backup_warning",
  "backup_local_only",
  "backup_unverified",
  "backup_stale",
  "location_ping_silent",
  "agent_wake_dead",
  "closed_stamp_stray",
  "closed_stamp_missing",
  "source_late",
  "source_silent",
  "device_silent",
  "probe_unresolved",
  "token_not_bound",
  "sources_collecting_unused",
  "import_needs_review"
] as const;
export type DoctorCheck = (typeof DOCTOR_CHECKS)[number];

/** Checks the design names that are not built, so a "Healthy" summary never claims them. */
export const DOCTOR_UNBUILT_CHECKS: readonly { check: string; reason: string }[] = [
  {
    check: "dismissed_still_linked",
    reason: "No item-level dismissed state exists to check; links to finished items are checked."
  }
];

export interface DoctorFix {
  /** `agent`: an agent with the scope can do it now. `person`: only the person knows; ask `question`. */
  who: "agent" | "person";
  question?: string;
  tool?: string;
  action?: string;
  /** What has to be supplied. */
  fields?: string[];
  cli?: string;
  /** The exact next step in words, for an agent, when one tool call does not say it. */
  next?: string;
}

export interface DoctorItem {
  /** Stable: the check name and the handles it is about. */
  id: string;
  check: DoctorCheck;
  tier: DoctorTier;
  area: DoctorArea;
  title: string;
  /** What it costs the engine, in one plain sentence. */
  why: string;
  /** `<type>:<id>` of what it is about. */
  handles: string[];
  /** When it became true, ISO, if known. */
  since?: string;
  /** The date it is tied to, ISO, if any; a date inside `soonDays` ranks it first in its tier. */
  dueAt?: string;
  fix: DoctorFix;
}

export interface DoctorNotChecked {
  check: string;
  reason: string;
}

export interface DoctorReport {
  generatedAt: string;
  /** Healthy when every check that exists ran and found nothing; not-checked entries sit beside it. */
  healthy: boolean;
  counts: Record<DoctorTier, number>;
  byArea: Partial<Record<DoctorArea, number>>;
  items: DoctorItem[];
  notChecked: DoctorNotChecked[];
  /** The data-source counts the Data check and Connections headers show; absent when the source checks were not given. */
  sources?: DoctorSourceCounts;
  /** Whether every source that can change the plan is read up to date, and the sentence to show when not. Absent with `sources`. */
  planInputs?: PlanInputs;
  /** Messages collected against messages that reached an end state, per message source; absent when none reports. */
  processing?: ProcessingReport[];
}

export interface DoctorProject {
  id: string;
  title: string;
  status: string;
  lastWorkedAt: string | null;
  focus: boolean;
  openActionCount: number;
  openDeliverableCount: number;
  externalDeadlineAt: string | null;
}
export interface DoctorAction {
  id: string;
  title: string;
  projectId: string | null;
  status: string;
  lastWorkedAt: string | null;
  /** Names the estimate fields filled in by a default instead of by a person. */
  assumedFields: string[];
  hasEstimate: boolean;
}
export interface DoctorRoutine {
  id: string;
  title: string;
  /** Days between runs; null when it has none. */
  intervalDays: number | null;
  lastCompletedAt: string | null;
  /** When the series began (or the action was created); a routine never done lapses from here. */
  startedAt: string | null;
  /** The end of the series' last day, as an instant in the person's time zone. */
  endDate: string | null;
  status: string;
}
export interface DoctorCommitment {
  id: string;
  title: string;
  startsAt: string;
  status: string;
  /** In person with no place set. */
  missingPlace: boolean;
  /** In person with no travel mode set. */
  missingTransport: boolean;
}
export interface DoctorHeldEvent {
  batchId: string;
  provider: string;
  heldSince: string;
}
export interface DoctorSyncRun {
  provider: string;
  /** `synced`, `needs_review`, `failed` or `not_configured`. */
  status: string;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
}
export interface DoctorReview {
  id: string;
  type: "area" | "outcome";
  title: string;
  /** When its review fell due, ISO. */
  dueAt: string;
}

export interface DoctorSnapshot {
  now: string;
  freshness: Freshness;
  /** The wake is the one fact the person must give (`rhen_wake`); a null last-woke is never dated. */
  pulseOffSince: string | null;
  projects: DoctorProject[];
  actions: DoctorAction[];
  routines: DoctorRoutine[];
  commitments: DoctorCommitment[];
  heldEvents: DoctorHeldEvent[];
  syncRuns: DoctorSyncRun[];
  /** Connections whose manifest declares a diff profile nothing registered, so their sync would fail (absent: none). */
  unregisteredDiffProfiles?: { connectionId: string; profile: string }[];
  reviews: DoctorReview[];
  /** Counts only; the owner of each ledger lists the entries. */
  catchUpUnsettled: number;
  openFindings: number;
  proposalsWaiting: { id: string; waitingSince: string }[];
  /** Slices owned by their own check files (`doctor-*.ts`). */
  prerequisites: DoctorPrerequisitesSlice;
  people?: DoctorPeopleSlice;
  publishing: DoctorPublishingSlice;
  cadence: DoctorCadenceSlice;
  duplicates: DoctorDuplicatesSlice;
  recording: DoctorRecordingSlice;
  closed: DoctorClosedSlice;
  /** The registry's source health (`doctor-sources.ts`); absent for a caller with no registry, which then raises none of those checks. */
  sources?: DoctorSourcesSlice;
}

/** The slices of a database with none of those problems (a backup that just ran), for a caller that has nothing to say about them. */
export function emptyDoctorSlices(
  now: string
): Pick<DoctorSnapshot, "prerequisites" | "publishing" | "cadence" | "duplicates" | "recording" | "closed"> {
  return {
    prerequisites: { projects: [], deliverables: [], actions: [], blockers: [], contactLinkedHandles: [] },
    publishing: { calendarSink: null, pushDevices: [], pulse: null },
    cadence: { cadences: [], recurring: [], syncs: [] },
    duplicates: { actions: [], proposals: [], openDuplicateFindingItemIds: [], deadLinkEnds: [] },
    recording: {
      backup: { status: "synced", lastRunAt: now, lastSuccessAt: now },
      phonePing: { configured: false, lastPingAt: null },
      deadAgentWakes: { count: 0, lastError: null }
    },
    closed: { tables: [] }
  };
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const DOCTOR_OPEN_ACTION_STATUSES = ["inbox", "planned", "active", "doing", "waiting", "blocked"] as const;
const OPEN_ACTION = new Set<string>(DOCTOR_OPEN_ACTION_STATUSES);

function ms(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function ago(from: number, now: number): string {
  const hours = Math.round((now - from) / HOUR);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

export function runDoctor(snapshot: DoctorSnapshot): DoctorReport {
  const now = ms(snapshot.now) ?? Date.now();
  const items: DoctorItem[] = [];
  const T = DOCTOR_THRESHOLDS;

  // Facts: the wake, the open session, and the place the engine plans from.
  const { freshness } = snapshot;
  if (freshness.wake.stale)
    items.push({
      id: "stale_wake",
      check: "stale_wake",
      tier: "blocking",
      area: "facts",
      title: "Wake time is out of date",
      why: "Capacity for the day is planned from the last recorded wake, so every plan since is a guess.",
      handles: [],
      ...(freshness.wake.asOf ? { since: freshness.wake.asOf } : {}),
      fix: {
        who: "person",
        question: "When did you wake up?",
        tool: "rhen_wake",
        action: "wake",
        fields: ["at"],
        cli: "rhen wake --at <time>"
      }
    });
  if (freshness.session.stale)
    items.push({
      id: "stale_session",
      check: "stale_session",
      tier: "blocking",
      area: "facts",
      title: "A session is still open past its end",
      why: "The engine thinks you are still busy, so it plans nothing around you.",
      handles: [],
      ...(freshness.session.asOf ? { since: freshness.session.asOf } : {}),
      fix: {
        who: "person",
        question: "When did the open session stop?",
        tool: "rhen_session",
        action: "finish",
        fields: ["ended-at"],
        cli: "rhen session finish --ended-at <time>"
      }
    });
  if (freshness.location.stale)
    items.push({
      id: "stale_location",
      check: "stale_location",
      tier: "blocking",
      area: "facts",
      title: "Your place is out of date",
      why: "Travel and what can be done here are planned from where you were last said to be.",
      handles: [],
      ...(freshness.location.asOf ? { since: freshness.location.asOf } : {}),
      fix: {
        who: "person",
        question: "Where are you now?",
        tool: "rhen_arrive",
        action: "arrive",
        fields: ["place"],
        cli: "rhen arrive <place>"
      }
    });
  if (freshness.energy.stale)
    items.push({
      id: "stale_energy",
      check: "stale_energy",
      tier: "tidy",
      area: "facts",
      title: "Energy is out of date",
      why: "Heavy work may be offered when you are flat, or held back when you are not.",
      handles: [],
      ...(freshness.energy.asOf ? { since: freshness.energy.asOf } : {}),
      fix: {
        who: "person",
        question: "How is your energy now?",
        tool: "rhen_save",
        action: "save",
        fields: ["currentEnergy"],
        cli: "rhen save current_availability --set currentEnergy=<high|medium|low|recovery>"
      }
    });
  if (snapshot.pulseOffSince)
    items.push({
      id: "pulse_off",
      check: "pulse_off",
      tier: "blocking",
      area: "facts",
      title: "The pulse has stayed off",
      why: "OpenRhen lost contact; until you re-enter, agents are refused and the plan is not trusted.",
      handles: [],
      since: snapshot.pulseOffSince,
      fix: {
        who: "person",
        question: "Ready to re-enter the plan?",
        tool: "rhen_reenter",
        action: "reenter",
        fields: [],
        cli: "rhen reenter"
      }
    });

  // Integrations carry status only: provider, state, since.
  for (const run of snapshot.syncRuns) {
    if (run.status === "not_configured") continue;
    const last = ms(run.lastSuccessAt);
    const failing =
      run.status === "failed" ||
      (last !== undefined &&
        now - last > T.syncFailingHours * HOUR &&
        run.status !== "synced" &&
        run.status !== "needs_review");
    if (!failing) continue;
    items.push({
      id: `sync_failing:${run.provider}`,
      check: "sync_failing",
      tier: "blocking",
      area: "integrations",
      title: `${run.provider} sync is failing`,
      why: "What it brings in is going stale, so the plan drifts from the real calendar or inbox.",
      handles: [],
      ...(run.lastSuccessAt ? { since: run.lastSuccessAt } : {}),
      fix: {
        who: "person",
        question: `Reconnect ${run.provider}; it has not synced ${last ? `for ${ago(last, now)}` : "yet"}.`
      }
    });
  }

  // A manifest naming a diff profile that did not register (an overlay that failed to load) fails every sync.
  for (const gap of snapshot.unregisteredDiffProfiles ?? []) {
    items.push({
      id: `diff_profile_unregistered:${gap.connectionId}`,
      check: "diff_profile_unregistered",
      tier: "blocking",
      area: "integrations",
      title: `${gap.connectionId} cannot sync: its diff profile "${gap.profile}" is not registered`,
      why: "The build that declares this connection did not load the code that reads it, so every sync of it fails.",
      handles: [],
      fix: {
        who: "person",
        question: `Check that the build includes the "${gap.profile}" profile for ${gap.connectionId}.`
      }
    });
  }

  // Calendar.
  for (const held of snapshot.heldEvents) {
    const since = ms(held.heldSince);
    if (since === undefined || now - since < T.heldEventDays * DAY) continue;
    items.push({
      id: `event_held:${held.batchId}`,
      check: "event_held",
      tier: "blocking",
      area: "calendar",
      title: `${held.provider} events held for review for ${ago(since, now)}`,
      why: "Events waiting in review are not on the plan, so time is planned over them.",
      handles: [`import_batch:${held.batchId}`],
      since: held.heldSince,
      fix: {
        who: "person",
        question: `${held.provider} events are waiting in review. Look at them in Inbox > Calendar and say which to keep.`
      }
    });
  }
  for (const c of snapshot.commitments) {
    const start = ms(c.startsAt);
    if (start === undefined || (c.status !== "scheduled" && c.status !== "active")) continue;
    if (!(c.missingPlace || c.missingTransport)) continue;
    const soon = start >= now && start - now <= T.commitmentDetailDays * DAY;
    if (!soon) continue;
    const needs = [c.missingPlace ? "a place" : "", c.missingTransport ? "a travel mode" : ""].filter(Boolean);
    items.push({
      id: `commitment_detail:${c.id}`,
      check: "commitment_detail",
      tier: "blocking",
      area: "calendar",
      title: `${c.title} needs ${needs.join(" and ")}`,
      why: "Without it no leave-by time is planned and the commitment is not protected properly.",
      handles: [`commitment:${c.id}`],
      dueAt: c.startsAt,
      fix: {
        who: "person",
        question: `${c.missingPlace ? `Where is ${c.title}` : `How do you get to ${c.title}`}${c.missingPlace && c.missingTransport ? ", and how do you get there" : ""}?`,
        tool: "rhen_save_commitment",
        action: "save",
        fields: [...(c.missingPlace ? ["locationId"] : []), ...(c.missingTransport ? ["transportMode"] : [])],
        cli: `rhen save commitment --id ${c.id}${c.missingPlace ? " --set locationId=<place>" : ""}${c.missingTransport ? " --set transportMode=<car|bike|walk>" : ""}`
      }
    });
  }

  // Plan.
  const projectById = new Map(snapshot.projects.map((p) => [p.id, p]));
  for (const a of snapshot.actions) {
    if (!OPEN_ACTION.has(a.status)) continue;
    const project = a.projectId ? projectById.get(a.projectId) : undefined;
    if (project && project.status !== "active") continue;
    if (a.hasEstimate && a.assumedFields.length === 0) continue;
    items.push({
      id: `no_estimate:${a.id}`,
      check: "no_estimate",
      tier: "degrading",
      area: "plan",
      title: `${a.title} has ${a.hasEstimate ? "only an assumed" : "no"} estimate`,
      why: "Capacity and sequencing lean on a default, so the plan over- or under-books.",
      handles: [`action:${a.id}`],
      fix: {
        who: "agent",
        tool: "rhen_save_action",
        action: "save",
        fields: ["id", "expectedMinutes"],
        cli: `rhen save action --id ${a.id} --set expectedMinutes=<minutes>`
      }
    });
  }
  // Remaining times the forecast already discounted for their age; the plan used them as given and lost a band of confidence.
  for (const e of freshness.effort) {
    if (!e.stale) continue;
    items.push({
      id: `aged_estimate:${e.actionId}`,
      check: "aged_estimate",
      tier: "degrading",
      area: "plan",
      title: `The time left on ${e.title} was last set a while ago`,
      why: "Its project is behind or at risk, and an old remaining time lowers the forecast's confidence.",
      handles: [`action:${e.actionId}`, `project:${e.projectId}`],
      since: e.asOf,
      fix: {
        who: "person",
        question: `Is ${e.remainingMinutes} minutes still what is left on ${e.title}?`,
        tool: "rhen_save_action",
        action: "save",
        fields: ["id", "remainingMinutes"],
        cli: `rhen save action --id ${e.actionId} --set remainingMinutes=<minutes>`
      }
    });
  }
  for (const p of snapshot.projects) {
    if (p.status !== "active") continue;
    if (p.openActionCount === 0 && p.openDeliverableCount > 0)
      items.push({
        id: `nothing_to_do:${p.id}`,
        check: "nothing_to_do",
        tier: "degrading",
        area: "plan",
        title: `${p.title} has an open deliverable but no action`,
        why: "The engine has nothing to offer for it, so it can only be reached by hand.",
        handles: [`project:${p.id}`],
        fix: {
          who: "agent",
          tool: "rhen_save_action",
          action: "save",
          fields: ["projectId", "title"],
          cli: `rhen save action --set projectId=${p.id} --set title=<next step>`
        }
      });
    const deadline = ms(p.externalDeadlineAt);
    if (deadline !== undefined && deadline < now)
      items.push({
        id: `deadline_passed:${p.id}`,
        check: "deadline_passed",
        tier: "degrading",
        area: "plan",
        title: `${p.title} is past its deadline and still active`,
        why: "A passed deadline keeps the project ranked as overdue instead of being finished, moved or dropped.",
        handles: [`project:${p.id}`],
        since: p.externalDeadlineAt!,
        fix: {
          who: "person",
          question: `${p.title} passed its deadline. Is it done, moved to a new date, or dropped?`,
          tool: "rhen_save_project",
          action: "save",
          fields: ["id", "status"],
          cli: `rhen save project --id ${p.id} --set status=<completed|paused>`
        }
      });
    const worked = ms(p.lastWorkedAt);
    if (!p.focus && worked !== undefined && now - worked > T.idleDays * DAY)
      items.push({
        id: `idle_project:${p.id}`,
        check: "idle_project",
        tier: "tidy",
        area: "staleness",
        title: `${p.title} untouched for ${ago(worked, now)}`,
        why: "An idle active project clutters the plan and dilutes ranking.",
        handles: [`project:${p.id}`],
        since: p.lastWorkedAt!,
        fix: {
          who: "person",
          question: `Keep, pause or drop ${p.title} (dropping it is rhen_cancel)?`,
          tool: "rhen_save_project",
          action: "save",
          fields: ["id", "status"],
          cli: `rhen save project --id ${p.id} --set status=<active|paused>`
        }
      });
  }

  // Routines.
  for (const r of snapshot.routines) {
    if (r.status !== "active" || r.intervalDays === null) continue;
    const end = ms(r.endDate);
    if (end !== undefined && end < now)
      items.push({
        id: `routine_ended:${r.id}`,
        check: "routine_ended",
        tier: "degrading",
        area: "routines",
        title: `${r.title} ended but is still active`,
        why: "A finished series keeps being planned.",
        handles: [`action:${r.id}`],
        since: r.endDate!,
        fix: {
          who: "agent",
          tool: "rhen_cancel",
          action: "close",
          fields: ["type", "id", "do", "reason"],
          cli: `rhen cancel action ${r.id} close --reason "<why>"`
        }
      });
    const last = ms(r.lastCompletedAt) ?? ms(r.startedAt);
    if (last !== undefined && now - last > T.routineLapsedIntervals * r.intervalDays * DAY)
      items.push({
        id: `routine_lapsed:${r.id}`,
        check: "routine_lapsed",
        tier: "degrading",
        area: "routines",
        title: `${r.title} ${r.lastCompletedAt ? "not done" : "never done"} for ${ago(last, now)}`,
        why: "It has lapsed; the plan keeps scheduling it and it keeps being missed.",
        handles: [`action:${r.id}`],
        since: new Date(last).toISOString(),
        fix: { who: "person", question: `${r.title} has lapsed. Keep it, change how often, or drop it?` }
      });
  }

  // Reviews overdue.
  for (const rv of snapshot.reviews) {
    const due = ms(rv.dueAt);
    if (due === undefined || due > now) continue;
    items.push({
      id: `review_overdue:${rv.type}:${rv.id}`,
      check: "review_overdue",
      tier: "tidy",
      area: "staleness",
      title: `Review of ${rv.title} is overdue`,
      why: "Nobody has checked this still matters.",
      handles: [`${rv.type}:${rv.id}`],
      since: rv.dueAt,
      fix: { who: "person", question: `Still the right shape: ${rv.title}?` }
    });
  }

  // Proposals waiting.
  for (const pr of snapshot.proposalsWaiting) {
    const since = ms(pr.waitingSince);
    if (since === undefined || now - since < T.proposalWaitingDays * DAY) continue;
    items.push({
      id: `proposal_waiting:${pr.id}`,
      check: "proposal_waiting",
      tier: "tidy",
      area: "ledgers",
      title: `A proposal has waited ${ago(since, now)}`,
      why: "A stale proposal is probably out of date.",
      handles: [`proposal:${pr.id}`],
      since: pr.waitingSince,
      fix: { who: "person", question: "Accept or drop it?" }
    });
  }

  // Ledgers owned elsewhere: one line each, a link, never the entries.
  if (snapshot.catchUpUnsettled > 0)
    items.push({
      id: "catch_up_unsettled",
      check: "catch_up_unsettled",
      tier: "degrading",
      area: "ledgers",
      title: `${snapshot.catchUpUnsettled} things in catch-up have no outcome`,
      why: "Unrecorded outcomes make the plan reason from what did not happen.",
      handles: [],
      fix: {
        who: "person",
        question: "What happened to each?",
        tool: "rhen_catch_up",
        action: "catch-up",
        cli: "rhen catch-up"
      }
    });
  if (snapshot.openFindings > 0)
    items.push({
      id: "open_findings",
      check: "open_findings",
      tier: "tidy",
      area: "ledgers",
      title: `${snapshot.openFindings} plan findings are open`,
      why: "Known gaps in the plan data are waiting for a decision.",
      handles: [],
      fix: { who: "person", question: "Accept or dismiss the open findings?" }
    });

  items.push(
    ...prerequisiteItems(snapshot.prerequisites, now),
    ...(snapshot.people ? doctorPeopleItems(snapshot.people, now) : []),
    ...publishingItems(snapshot.publishing, now),
    ...cadenceItems(snapshot.cadence, now),
    ...duplicateItems(snapshot.duplicates, now),
    ...recordingItems(snapshot.recording, now),
    ...closedStampItems(snapshot.closed)
  );

  const notChecked: DoctorNotChecked[] = [...DOCTOR_UNBUILT_CHECKS];
  let sources: DoctorSourceCounts | undefined;
  let inputs: PlanInputs | undefined;
  let processing: ProcessingReport[] | undefined;
  if (snapshot.sources) {
    if (snapshot.sources.unavailable !== undefined) {
      for (const check of DOCTOR_SOURCE_CHECKS)
        notChecked.push({
          check,
          reason:
            "the source health probes could not be read, so this check did not run; run `rhen sources --problems`, and if that also fails run `rhen doctor` again in a minute (results are cached for up to a minute)"
        });
    } else {
      const found = sourceItems(snapshot.sources, now);
      sources = found.counts;
      inputs = planInputs(snapshot.sources, now);
      if ((snapshot.sources.processing ?? []).length > 0) processing = snapshot.sources.processing;
      items.push(...found.items);
      // A silent phone is one device item; the separate location-ping item would say the same thing twice.
      if (found.devicePing)
        for (let index = items.length - 1; index >= 0; index -= 1)
          if (items[index]!.check === "location_ping_silent") items.splice(index, 1);
    }
  }

  items.sort(compare(now));

  const counts: Record<DoctorTier, number> = { blocking: 0, degrading: 0, tidy: 0 };
  const byArea: Partial<Record<DoctorArea, number>> = {};
  for (const item of items) {
    counts[item.tier] += 1;
    byArea[item.area] = (byArea[item.area] ?? 0) + 1;
  }
  return {
    generatedAt: snapshot.now,
    healthy: items.length === 0,
    counts,
    byArea,
    items,
    notChecked,
    ...(sources ? { sources } : {}),
    ...(inputs ? { planInputs: inputs } : {}),
    ...(processing ? { processing } : {})
  };
}

function compare(now: number) {
  const soon = DOCTOR_THRESHOLDS.soonDays * DAY;
  const near = (item: DoctorItem): boolean => {
    const due = ms(item.dueAt);
    return due !== undefined && due >= now && due - now <= soon;
  };
  return (a: DoctorItem, b: DoctorItem): number => {
    const tier = DOCTOR_TIERS.indexOf(a.tier) - DOCTOR_TIERS.indexOf(b.tier);
    if (tier !== 0) return tier;
    if (near(a) !== near(b)) return near(a) ? -1 : 1;
    if (near(a) && near(b) && ms(a.dueAt) !== ms(b.dueAt)) return ms(a.dueAt)! - ms(b.dueAt)!;
    // Older first; an item with no date after the dated ones, then by id so the order is stable.
    const sa = ms(a.since) ?? Number.POSITIVE_INFINITY;
    const sb = ms(b.since) ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}
