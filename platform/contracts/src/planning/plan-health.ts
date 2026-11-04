import { codesIn } from "./plan-code-pattern.js";
/**
 * Plan health checks: pure, deterministic rules over a
 * plain snapshot of the plan, with no database and no model. Each returns finding drafts; the portal
 * store loads the snapshot and writes the drafts to `plan_findings`. Nothing here changes a plan row.
 *
 * A draft's `text` is the finding's identity: it never carries a count or anything else that changes
 * from day to day, so the daily run can tell "already raised" from "new" by `checkName` plus `text`.
 */

export const PLAN_HEALTH_CHECKS = [
  "unit_code_no_project",
  "stale_deadline",
  "empty_assessment",
  "blocker_no_person",
  "no_practice_before_deadline",
  "duplicate_captures"
] as const;
export type PlanHealthCheck = (typeof PLAN_HEALTH_CHECKS)[number];

export const PLAN_HEALTH_CHECK_LABELS: Record<PlanHealthCheck, string> = {
  unit_code_no_project: "Unit code with no project",
  stale_deadline: "Deadline passed on an active item",
  empty_assessment: "Deliverable with no steps or criteria",
  blocker_no_person: "Blocker waiting on a person with no contact",
  no_practice_before_deadline: "Subject deadline with no preparation",
  duplicate_captures: "Duplicate capture"
};

/** `checkName` as a person-readable label; a name that is not a health check reads as itself. */
export function planHealthCheckLabel(checkName: string): string {
  return (PLAN_HEALTH_CHECK_LABELS as Record<string, string>)[checkName] ?? checkName;
}

/** A subject deadline inside this many days with nothing preparing for it raises a finding. */
export const PLAN_HEALTH_PRACTICE_WINDOW_DAYS = 14;
/** Commitments this many days old or newer, and emails this many days old or newer, are scanned for unit codes. */
export const PLAN_HEALTH_COMMITMENT_LOOKBACK_DAYS = 30;
export const PLAN_HEALTH_EMAIL_LOOKBACK_DAYS = 90;

export interface HealthFindingDraft {
  checkName: PlanHealthCheck;
  /** `<type>:<id>` handles of the items the finding is about. */
  itemIds: string[];
  text: string;
  evidence: string[];
  suggestedChanges: unknown[];
}

const FINISHED_ACTION = new Set(["done", "cancelled", "archived"]);
const FINISHED_DELIVERABLE = new Set(["completed", "cancelled", "archived"]);
const OPEN_BLOCKER = new Set(["open", "awaiting_response"]);

export interface HealthProject {
  id: string;
  title: string;
  status: string;
  externalDeadlineAt: Date | null;
}
export interface HealthDeliverable {
  id: string;
  projectId: string;
  title: string;
  status: string;
  externalDeadlineAt: Date | null;
  actionCount: number;
  criterionCount: number;
}
export interface HealthAction {
  id: string;
  projectId: string;
  title: string;
  status: string;
  deadlineAt: Date | null;
  schedulingMode: string;
}
export interface HealthBlocker {
  id: string;
  deliverableId: string;
  description: string;
  category: string;
  state: string;
}
export interface HealthCommitment {
  id: string;
  title: string;
  startsAt: Date;
  status: string;
}
export interface HealthEmail {
  id: string;
  subject: string | null;
  receivedAt: Date | null;
  /** Unit codes the extraction named, besides any in the subject. */
  unitCodes: string[];
}
/** A pending Inbox proposal, with the title it would create (or the source's title when it has none). */
export interface HealthProposal {
  id: string;
  sourceId: string;
  proposalType: string;
  title: string;
}
export interface HealthLink {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  kind: string;
  status: string;
}

export interface HealthSnapshot {
  now: Date;
  projects: HealthProject[];
  deliverables: HealthDeliverable[];
  actions: HealthAction[];
  blockers: HealthBlocker[];
  commitments: HealthCommitment[];
  emails: HealthEmail[];
  proposals: HealthProposal[];
  links: HealthLink[];
  subjects: { id: string; name: string; status: string }[];
  /** The owner's code pattern; absent or null turns the unit-code check off. */
  codePattern?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (date: Date): string => date.toISOString().slice(0, 10);
const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^(\s*(re|fwd?)\s*:\s*)+/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ---- Unit codes --------------------------------------------------------------------------------

/**
 * Reference codes as the owner's pattern defines them (`planCodePattern`); with no pattern there are none.
 * `anyCase` is for matching text a person typed into the plan, where a code may be lower-case.
 */
export function extractUnitCodes(
  text: string | null | undefined,
  pattern: string | null | undefined,
  anyCase = false
): string[] {
  if (!text) return [];
  return codesIn(anyCase ? text.toUpperCase() : text, pattern);
}

function unitCodeNoProject(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const known = new Set<string>();
  for (const project of snapshot.projects)
    for (const code of extractUnitCodes(project.title, snapshot.codePattern, true)) known.add(code);
  for (const deliverable of snapshot.deliverables)
    for (const code of extractUnitCodes(deliverable.title, snapshot.codePattern, true)) known.add(code);

  const evidenceByCode = new Map<string, string[]>();
  const commitmentsByCode = new Map<string, string[]>();
  const note = (code: string, line: string) => {
    const lines = evidenceByCode.get(code) ?? [];
    lines.push(line);
    evidenceByCode.set(code, lines);
  };
  const commitmentCutoff = snapshot.now.getTime() - PLAN_HEALTH_COMMITMENT_LOOKBACK_DAYS * DAY_MS;
  for (const commitment of snapshot.commitments) {
    if (commitment.status === "cancelled" || commitment.startsAt.getTime() < commitmentCutoff) continue;
    for (const code of extractUnitCodes(commitment.title, snapshot.codePattern)) {
      note(code, `Commitment "${clip(commitment.title)}" on ${day(commitment.startsAt)}`);
      commitmentsByCode.set(code, [...(commitmentsByCode.get(code) ?? []), commitment.id]);
    }
  }
  // An email's code counts only when the extraction named it, or a commitment title carries it too: an
  // order or reference number in a subject line is not a unit.
  const emailCutoff = snapshot.now.getTime() - PLAN_HEALTH_EMAIL_LOOKBACK_DAYS * DAY_MS;
  for (const email of snapshot.emails) {
    if (email.receivedAt && email.receivedAt.getTime() < emailCutoff) continue;
    const named = new Set(email.unitCodes.flatMap((code) => extractUnitCodes(code, snapshot.codePattern)));
    const codes = new Set([
      ...named,
      ...extractUnitCodes(email.subject, snapshot.codePattern).filter((code) => commitmentsByCode.has(code))
    ]);
    for (const code of codes) {
      note(
        code,
        `Email "${clip(email.subject ?? "(no subject)")}"${email.receivedAt ? ` on ${day(email.receivedAt)}` : ""}`
      );
    }
  }
  return [...evidenceByCode.keys()]
    .filter((code) => !known.has(code))
    .sort()
    .map((code) => ({
      checkName: "unit_code_no_project" as const,
      itemIds: [...new Set(commitmentsByCode.get(code) ?? [])]
        .sort()
        .slice(0, 5)
        .map((id) => `commitment:${id}`),
      text: `Unit code ${code} appears in the plan or email but no project or deliverable carries it.`,
      evidence: evidenceByCode.get(code)!.slice(0, 8),
      suggestedChanges: [`Create a project for ${code} and link its commitments to it.`]
    }));
}

// ---- Stale deadlines ---------------------------------------------------------------------------

function staleDeadline(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const drafts: HealthFindingDraft[] = [];
  const activeProjects = new Map<string, HealthProject>();
  for (const project of snapshot.projects) {
    if (project.status !== "active") continue;
    activeProjects.set(project.id, project);
    if (project.externalDeadlineAt && project.externalDeadlineAt < snapshot.now) {
      drafts.push({
        checkName: "stale_deadline",
        itemIds: [`project:${project.id}`],
        text: `Project "${project.title}" is active but its deadline (${day(project.externalDeadlineAt)}) has passed.`,
        evidence: [`Deadline ${day(project.externalDeadlineAt)}, today ${day(snapshot.now)}`],
        suggestedChanges: []
      });
    }
  }
  for (const deliverable of snapshot.deliverables) {
    if (FINISHED_DELIVERABLE.has(deliverable.status) || !activeProjects.has(deliverable.projectId)) continue;
    if (deliverable.externalDeadlineAt && deliverable.externalDeadlineAt < snapshot.now) {
      drafts.push({
        checkName: "stale_deadline",
        itemIds: [`deliverable:${deliverable.id}`],
        text: `Deliverable "${deliverable.title}" is active but its deadline (${day(deliverable.externalDeadlineAt)}) has passed.`,
        evidence: [
          `Deadline ${day(deliverable.externalDeadlineAt)}, today ${day(snapshot.now)}`,
          `Project "${activeProjects.get(deliverable.projectId)!.title}"`
        ],
        suggestedChanges: []
      });
    }
  }
  return drafts;
}

// ---- Empty assessments -------------------------------------------------------------------------

function emptyAssessment(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const activeProjects = new Set(snapshot.projects.filter((p) => p.status === "active").map((p) => p.id));
  return snapshot.deliverables
    .filter(
      (d) =>
        !FINISHED_DELIVERABLE.has(d.status) &&
        activeProjects.has(d.projectId) &&
        d.actionCount === 0 &&
        d.criterionCount === 0
    )
    .map((d) => ({
      checkName: "empty_assessment" as const,
      itemIds: [`deliverable:${d.id}`],
      text: `Deliverable "${d.title}" has no steps and no completion criteria.`,
      evidence: [`Status ${d.status}`],
      suggestedChanges: []
    }));
}

// ---- Blockers with no person -------------------------------------------------------------------

function blockerNoPerson(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const withContact = new Set(
    snapshot.links
      .filter((l) => l.kind === "involves" && l.status === "confirmed" && l.toType === "contact")
      .map((l) => `${l.fromType}:${l.fromId}`)
  );
  const deliverables = new Map(snapshot.deliverables.map((d) => [d.id, d]));
  const drafts: HealthFindingDraft[] = [];
  for (const blocker of snapshot.blockers) {
    if (blocker.category !== "waiting_on_someone" || !OPEN_BLOCKER.has(blocker.state)) continue;
    const deliverable = deliverables.get(blocker.deliverableId);
    if (!deliverable || FINISHED_DELIVERABLE.has(deliverable.status)) continue;
    if (withContact.has(`deliverable:${deliverable.id}`)) continue;
    drafts.push({
      checkName: "blocker_no_person",
      itemIds: [`deliverable:${deliverable.id}`],
      text: `Blocker "${clip(blocker.description)}" on "${deliverable.title}" is waiting on someone, but no contact is attached.`,
      evidence: [`Blocker state ${blocker.state}`],
      suggestedChanges: ["Link the deliverable to the person it is waiting on (involves)."]
    });
  }
  return drafts;
}

// ---- No practice before a deadline -------------------------------------------------------------

interface DatedItem {
  handle: string;
  title: string;
  at: Date;
}

function noPracticeBeforeDeadline(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const confirmed = snapshot.links.filter((l) => l.status === "confirmed");
  const windowEnd = new Date(snapshot.now.getTime() + PLAN_HEALTH_PRACTICE_WINDOW_DAYS * DAY_MS);
  const dated = new Map<string, DatedItem>();
  const add = (type: string, id: string, title: string, at: Date | null) => {
    if (at) dated.set(`${type}:${id}`, { handle: `${type}:${id}`, title, at });
  };
  for (const p of snapshot.projects) if (p.status === "active") add("project", p.id, p.title, p.externalDeadlineAt);
  for (const d of snapshot.deliverables)
    if (!FINISHED_DELIVERABLE.has(d.status)) add("deliverable", d.id, d.title, d.externalDeadlineAt);
  for (const a of snapshot.actions) if (!FINISHED_ACTION.has(a.status)) add("action", a.id, a.title, a.deadlineAt);
  for (const c of snapshot.commitments) if (c.status !== "cancelled") add("commitment", c.id, c.title, c.startsAt);

  const openActions = new Map(snapshot.actions.filter((a) => !FINISHED_ACTION.has(a.status)).map((a) => [a.id, a]));
  const drafts: HealthFindingDraft[] = [];
  for (const subject of snapshot.subjects) {
    if (subject.status !== "active") continue;
    const aboutIt = confirmed.filter((l) => l.kind === "about" && l.toType === "subject" && l.toId === subject.id);
    const upcoming = aboutIt
      .map((l) => dated.get(`${l.fromType}:${l.fromId}`))
      .filter((item): item is DatedItem => !!item && item.at >= snapshot.now && item.at <= windowEnd)
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.handle.localeCompare(b.handle));
    if (upcoming.length === 0) continue;

    const targets = new Set([`subject:${subject.id}`, ...upcoming.map((item) => item.handle)]);
    const prepared = confirmed.some(
      (l) =>
        l.kind === "prepares" &&
        l.fromType === "action" &&
        openActions.has(l.fromId) &&
        targets.has(`${l.toType}:${l.toId}`)
    );
    const cadence = aboutIt.some((l) => {
      const action = l.fromType === "action" ? openActions.get(l.fromId) : undefined;
      return !!action && action.schedulingMode !== "one_off";
    });
    if (prepared || cadence) continue;

    const first = upcoming[0]!;
    drafts.push({
      checkName: "no_practice_before_deadline",
      itemIds: [`subject:${subject.id}`, ...upcoming.slice(0, 5).map((item) => item.handle)],
      text: `${subject.name} has a deadline within ${PLAN_HEALTH_PRACTICE_WINDOW_DAYS} days ("${first.title}", ${day(first.at)}) and no action prepares for it.`,
      evidence: upcoming.slice(0, 5).map((item) => `"${item.title}" on ${day(item.at)}`),
      suggestedChanges: [`Add a practice action for ${subject.name} and link it with prepares.`]
    });
  }
  return drafts;
}

// ---- Duplicate captures ------------------------------------------------------------------------

function duplicateCaptures(snapshot: HealthSnapshot): HealthFindingDraft[] {
  const drafts: HealthFindingDraft[] = [];

  const proposals = new Map<string, HealthProposal[]>();
  for (const proposal of snapshot.proposals) {
    const key = `${proposal.proposalType}\u0000${normalise(proposal.title)}`;
    proposals.set(key, [...(proposals.get(key) ?? []), proposal]);
  }
  for (const group of [...proposals.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => a[0]!.title.localeCompare(b[0]!.title))) {
    const sources = [...new Set(group.map((p) => p.sourceId))];
    drafts.push({
      checkName: "duplicate_captures",
      itemIds: sources
        .sort()
        .slice(0, 5)
        .map((id) => `source:${id}`),
      text: `"${clip(group[0]!.title)}" is waiting in the Inbox more than once.`,
      evidence: [`${group.length} pending proposals from ${sources.length} source${sources.length === 1 ? "" : "s"}`],
      suggestedChanges: ["Keep one proposal and ignore the rest."]
    });
  }

  const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
  const actions = new Map<string, HealthAction[]>();
  for (const action of snapshot.actions) {
    if (FINISHED_ACTION.has(action.status) || !projects.has(action.projectId)) continue;
    const key = `${action.projectId}\u0000${normalise(action.title)}`;
    actions.set(key, [...(actions.get(key) ?? []), action]);
  }
  for (const group of [...actions.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => a[0]!.title.localeCompare(b[0]!.title))) {
    const project = projects.get(group[0]!.projectId)!;
    drafts.push({
      checkName: "duplicate_captures",
      itemIds: group
        .map((a) => a.id)
        .sort()
        .slice(0, 5)
        .map((id) => `action:${id}`),
      text: `Action "${clip(group[0]!.title)}" appears more than once in project "${project.title}".`,
      evidence: [`${group.length} open actions share this title`],
      suggestedChanges: ["Keep one action and cancel the rest."]
    });
  }
  return drafts;
}

/** Every check over one snapshot, in a fixed order. */
export function runPlanHealthChecks(snapshot: HealthSnapshot): HealthFindingDraft[] {
  return [
    ...unitCodeNoProject(snapshot),
    ...staleDeadline(snapshot),
    ...emptyAssessment(snapshot),
    ...blockerNoPerson(snapshot),
    ...noPracticeBeforeDeadline(snapshot),
    ...duplicateCaptures(snapshot)
  ];
}

/** The identity the daily run dedupes on: a finding already stored, in any state, is not raised again. */
export function healthFindingKey(finding: Pick<HealthFindingDraft, "checkName" | "text">): string {
  return `${finding.checkName}\u0000${finding.text}`;
}
