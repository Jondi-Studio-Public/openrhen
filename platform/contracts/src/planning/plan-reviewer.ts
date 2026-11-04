import type { BackendSummary } from "./plan-map-explorer.js";
import type { NudgeCapSummary } from "./plan-nudge.js";

/**
 * The weekly reviewer's digest: a pure summary of the week's
 * shadow evidence, composed into a few lines for one push message. It reads nothing and decides nothing;
 * the runner in `platform/database` gathers the inputs and applies the `reviewer` switch.
 */

/** A digest is due when the last one is at least this old; the daily sweep makes that weekly. */
export const REVIEWER_MIN_INTERVAL_DAYS = 6;
const DAY_MS = 86_400_000;

export interface ReviewerFindingsInput {
  /** Open findings now, by check, most numerous first. */
  openByCheck: { check: string; count: number }[];
  /** Newest open findings, as written; the digest quotes at most two, shortened. */
  topOpen: string[];
  acceptedThisWeek: number;
  dismissedThisWeek: number;
}

export interface ReviewerLinksInput {
  /** Suggested links still waiting for a decision. */
  waiting: number;
  confirmedThisWeek: number;
  rejectedThisWeek: number;
}

export interface ReviewerInput {
  findings: ReviewerFindingsInput;
  links: ReviewerLinksInput;
  /** One entry per cap, from the same reader as `GET /api/plan-map/nudge`. */
  nudge: NudgeCapSummary[];
  /** One entry per backend, from the explorer's own aggregation over the week's shadow rows. */
  explorer: BackendSummary[];
}

export interface ReviewerDigest {
  title: string;
  /** The digest lines, one per topic; empty topics are left out. */
  lines: string[];
  /** The push body: the lines joined, capped at `DIGEST_BODY_MAX`. */
  body: string;
  /** True when nothing happened this week, in which case nothing is pushed. */
  quiet: boolean;
}

export const DIGEST_BODY_MAX = 400;
const QUOTE_MAX = 70;

export function reviewerDue(lastDigestAt: Date | null, now: Date): boolean {
  return lastDigestAt === null || now.getTime() - lastDigestAt.getTime() >= REVIEWER_MIN_INTERVAL_DAYS * DAY_MS;
}

/** The outbox key for the digest sent on `now`'s UTC date, so a retry the same day cannot send a second push. */
export function reviewerDedupeKey(now: Date): string {
  return `plan_digest:${now.toISOString().slice(0, 10)}`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function tokensLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

function findingsLine(input: ReviewerFindingsInput): string | null {
  const open = input.openByCheck.reduce((sum, entry) => sum + entry.count, 0);
  if (open === 0 && input.acceptedThisWeek === 0 && input.dismissedThisWeek === 0) return null;
  const checks = input.openByCheck.slice(0, 3).map((entry) => `${entry.count} ${entry.check}`);
  const head = `${plural(open, "open finding")}${checks.length ? ` (${checks.join(", ")})` : ""}`;
  return `${head}; ${input.acceptedThisWeek} accepted, ${input.dismissedThisWeek} dismissed this week.`;
}

function linksLine(input: ReviewerLinksInput): string | null {
  if (input.waiting === 0 && input.confirmedThisWeek === 0 && input.rejectedThisWeek === 0) return null;
  return `${plural(input.waiting, "suggested link")} waiting; ${input.confirmedThisWeek} confirmed, ${input.rejectedThisWeek} rejected this week.`;
}

function nudgeLine(caps: readonly NudgeCapSummary[]): string | null {
  if (caps.every((cap) => cap.runs === 0)) return null;
  const join = (pick: (cap: NudgeCapSummary) => number) => caps.map(pick).join("/");
  const days = caps.map((cap) => cap.capDays).join("/");
  const slips = caps.reduce((sum, cap) => sum + cap.slippedDue, 0);
  return `Nudge (${days} day caps, shadow): ${join((cap) => cap.actionsMoved)} actions moved, ${join((cap) => cap.movedThenDone)} later done; ${
    slips === 0 ? "no due item displaced" : `${plural(slips, "due item")} displaced`
  }.`;
}

function explorerLine(backends: readonly BackendSummary[]): string | null {
  if (backends.length === 0) return null;
  const parts = backends.map((backend) => {
    const f1 = backend.meanF1 === null ? "no score" : `F1 ${backend.meanF1.toFixed(2)}`;
    return `${backend.backend} ${f1}, ${tokensLabel(backend.meanTokens)} tokens, ${plural(backend.runs, "run")}`;
  });
  return `Explorer: ${parts.join("; ")}.`;
}

export function composeDigest(input: ReviewerInput): ReviewerDigest {
  const lines = [
    findingsLine(input.findings),
    ...input.findings.topOpen.slice(0, 2).map((text) => `• ${shorten(text, QUOTE_MAX)}`),
    linksLine(input.links),
    nudgeLine(input.nudge),
    explorerLine(input.explorer)
  ].filter((line): line is string => line !== null);
  const joined = lines.join("\n");
  const body = joined.length <= DIGEST_BODY_MAX ? joined : `${joined.slice(0, DIGEST_BODY_MAX - 1).trimEnd()}…`;
  return { title: "Plan map week", lines, body, quiet: lines.length === 0 };
}
