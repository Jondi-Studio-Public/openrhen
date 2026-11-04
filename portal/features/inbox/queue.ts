import { dateTimeFormat, displayLocale } from "@/shared/locale";
import {
  planHealthCheckLabel,
  sourceLabel,
  unansweredQuestions,
  type AgentProposal,
  type PlanFinding,
  type PlanLink
} from "@openrhen/contracts";
import type { CaptureItem } from "@/state/portal-state";
import { extensionCaptureSender, mailSource, type ExtensionQueueRow } from "@/state/extensions";
import { groupEmailThreads } from "@/features/capture/email-threads";
import { proposalQuestions } from "@/features/capture/proposal-questions";
import {
  calendarsWaiting,
  type CalendarReviewCount,
  type CalendarReviewProvider
} from "@/features/calendar-sync/calendar-review-count";
import {
  describeImportBatchSource,
  describeImportBatchState,
  type ImportBatchSummary
} from "@/features/imports/import-queue";
import { LINK_KIND_LABELS, openFindings, type TitleResolver } from "@/features/plan-map/plan-map-model";
import { ageLabel } from "@/features/agent-proposals/agent-proposals-store";
import { canUndoIgnore } from "@/features/capture/capture-commands";
import { proposalTypeLabel } from "./proposal-type-label";
import { inboxWhen, sentenceCase } from "./source-label";
import type { InboxFilter, RoomId } from "./rooms";

/**
 * The Inbox as one queue: every item that waits, from every room, as rows of one shape (a title, a
 * line of where it came from and a tag) over the record the detail pane needs to decide it. Kept
 * free of React, so what is listed, in what order and under which chip can be tested as tables.
 */
export type QueueRecord =
  | { kind: "email"; items: CaptureItem[] }
  | { kind: "capture"; item: CaptureItem }
  | { kind: "agent"; proposal: AgentProposal }
  | { kind: "extension"; extensionId: string; row: ExtensionQueueRow }
  | { kind: "calendar"; provider: CalendarReviewProvider; batchId: string; count: number }
  | { kind: "import"; batch: ImportBatchSummary }
  | { kind: "link"; link: PlanLink }
  | { kind: "finding"; finding: PlanFinding }
  | { kind: "kept"; item: CaptureItem; shelf: "someday" | "reference" };

export type QueueTone = "neutral" | "info" | "warn";

export type QueueEntry = QueueRecord & {
  /** Stable across reloads, so the selection survives the list changing around it. */
  key: string;
  room: RoomId;
  title: string;
  meta: string;
  tag: { label: string; tone: QueueTone };
  /** Waits for a decision, so it is in the unfiltered queue and in the Inbox badge. */
  waiting: boolean;
  /** When an email thread or a capture arrived (a thread's newest message), for ageing the backlog. */
  arrivedAt?: string;
};

export interface QueueSources {
  emailItems: readonly CaptureItem[];
  /** Pending captures that are not email thread changes. */
  otherPending: readonly CaptureItem[];
  agentProposals: readonly AgentProposal[];
  /** Rows registered extensions add (see `extensionQueueRows`), in the order they list them. */
  extensionRows: readonly (ExtensionQueueRow & { extensionId: string })[];
  calendarReview: CalendarReviewCount;
  importQueue: readonly ImportBatchSummary[];
  links: readonly PlanLink[];
  findings: readonly PlanFinding[];
  someday: readonly CaptureItem[];
  reference: readonly CaptureItem[];
  /** What the registered mail source reads from portal state (`MailSource.contextFrom`). */
  emailContext: unknown;
  titleOf: TitleResolver["titleOf"];
  now: Date;
  /** The plan's zone, so a row reads the same clock as Now (not the browser's). */
  timezone?: string;
}

const text = (fields: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const titleOfCapture = (item: CaptureItem) => text(item.proposedFields, "title") ?? item.text;

const filed = (timeZone?: string) =>
  dateTimeFormat(displayLocale(), { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) });

const QUESTION = { label: "Question", tone: "warn" } as const;

function captureEntry(item: CaptureItem, now: Date, timezone?: string): QueueEntry {
  const sender = extensionCaptureSender(item.proposedFields);
  const asking = unansweredQuestions(proposalQuestions(item)).length > 0;
  return {
    kind: "capture",
    item,
    key: `capture:${item.id}`,
    room: "captured",
    title: titleOfCapture(item),
    meta: [
      sender ? `From ${sender}` : sentenceCase(item.sourceType),
      inboxWhen(item.createdAt, now, timezone),
      item.confidence !== undefined ? `${Math.round(item.confidence * 100)}% confidence` : null,
      text(item.proposedFields, "suggestedShape") === "deliverable" ? "suggested as a larger piece of work" : null
    ]
      .filter(Boolean)
      .join(" · "),
    // A capture nobody has sorted yet is "to sort", not the engine's "unclassified".
    tag: asking
      ? QUESTION
      : {
          label: item.proposalType === "unclassified" ? "To sort" : proposalTypeLabel(item.proposalType),
          tone: "neutral"
        },
    waiting: true,
    arrivedAt: item.createdAt
  };
}

function agentEntry(proposal: AgentProposal, now: Date): QueueEntry {
  return {
    kind: "agent",
    proposal,
    key: `agent:${proposal.id}`,
    room: "captured",
    title: proposal.summary,
    meta: `From ${sentenceCase(proposal.agent)} · ${ageLabel(proposal.createdAt, now.getTime())}`,
    tag: { label: "From an agent", tone: "info" },
    waiting: true
  };
}

function extensionEntry(row: ExtensionQueueRow & { extensionId: string }): QueueEntry {
  const { extensionId, data: _data, ...fields } = row;
  return { kind: "extension", extensionId, row, ...fields };
}

function linkEntry(link: PlanLink, titleOf: QueueSources["titleOf"]): QueueEntry {
  return {
    kind: "link",
    link,
    key: `link:${link.id}`,
    room: "map",
    title: `${titleOf(link.fromType, link.fromId)} ${LINK_KIND_LABELS[link.kind]} ${titleOf(link.toType, link.toId)}`,
    meta: `Links · suggested by ${sentenceCase(link.proposer)}`,
    tag: { label: "Suggested link", tone: "neutral" },
    waiting: true
  };
}

function findingEntry(finding: PlanFinding): QueueEntry {
  return {
    kind: "finding",
    finding,
    key: `finding:${finding.id}`,
    room: "map",
    title: finding.text,
    meta: `Links · ${planHealthCheckLabel(finding.checkName)}`,
    tag: finding.questions.length ? QUESTION : { label: "Worth a look", tone: "neutral" },
    waiting: true
  };
}

function keptEntry(item: CaptureItem, shelf: "someday" | "reference", timezone?: string): QueueEntry {
  return {
    kind: "kept",
    item,
    shelf,
    key: `kept:${item.id}`,
    room: "kept",
    title: titleOfCapture(item),
    meta: `${sentenceCase(item.sourceType)} · filed ${filed(timezone).format(new Date(item.reviewedAt ?? item.createdAt))}`,
    tag: { label: shelf === "someday" ? "Someday" : "Reference", tone: "neutral" },
    waiting: false
  };
}

/**
 * Every row the Inbox can list, in queue order: what agents are waiting on first, so it is never
 * buried, then the rooms in chip order. Within Captured, captures keep the order they arrived in.
 * A calendar's held events are one row per calendar, opening its review batch; a held import that is
 * not a calendar's is listed under Calendar too but does not count as waiting, as before.
 */
export function buildQueue(sources: QueueSources): QueueEntry[] {
  const { now, timezone } = sources;
  const agents = sources.agentProposals.filter((proposal) => proposal.status === "pending");
  const calendarBatchIds = new Set<string>();
  const calendars: QueueEntry[] = [];
  for (const provider of calendarsWaiting(sources.calendarReview)) {
    const count = sources.calendarReview.counts[provider] ?? 0;
    const batchId = sources.calendarReview.batchIds[provider]!;
    calendarBatchIds.add(batchId);
    calendars.push({
      kind: "calendar",
      provider,
      batchId,
      count,
      key: `calendar:${provider}`,
      room: "calendar",
      title: `${sourceLabel(provider)}: ${count} event${count === 1 ? "" : "s"} to review`,
      meta: `Calendar · ${sourceLabel(provider)}`,
      tag: { label: "Calendar", tone: "info" },
      waiting: true
    });
  }
  const imports: QueueEntry[] = sources.importQueue
    .filter((batch) => !calendarBatchIds.has(batch.id))
    .map((batch) => ({
      kind: "import",
      batch,
      key: `import:${batch.id}`,
      room: "calendar",
      title: describeImportBatchSource(batch),
      meta: `Held import · ${describeImportBatchState(batch)}`,
      tag: { label: "Held import", tone: "neutral" },
      waiting: false
    }));
  return [
    ...agents.map((proposal) => agentEntry(proposal, now)),
    ...groupEmailThreads([...sources.emailItems]).flatMap((thread) => {
      const row = mailSource()?.entry(thread.items, sources.emailContext, now);
      return row ? [row] : [];
    }),
    ...sources.extensionRows.map((row) => extensionEntry(row)),
    ...sources.otherPending.map((item) => captureEntry(item, now, timezone)),
    ...calendars,
    ...imports,
    ...sources.links.filter((link) => link.status === "suggested").map((link) => linkEntry(link, sources.titleOf)),
    ...openFindings(sources.findings).map((finding) => findingEntry(finding)),
    ...sources.someday.map((item) => keptEntry(item, "someday", timezone)),
    ...sources.reference.map((item) => keptEntry(item, "reference", timezone))
  ];
}

/** The rows a chip shows: everything waiting for All, or all of one room's rows, waiting or not. */
export function entriesFor(queue: readonly QueueEntry[], filter: InboxFilter): QueueEntry[] {
  return filter === "all" ? queue.filter((entry) => entry.waiting) : queue.filter((entry) => entry.room === filter);
}

const DAY_MS = 86_400_000;
export const STALE_DAYS = 14;

/**
 * The emails and captures that have waited longer than two weeks and can be ignored in one go with an
 * Undo that puts every one back (a proposal from another person cannot be put back, so it is never swept).
 */
export function staleEntries(entries: readonly QueueEntry[], now: Date): QueueEntry[] {
  const cutoff = now.getTime() - STALE_DAYS * DAY_MS;
  return entries.filter((entry) => {
    if (!entry.arrivedAt || new Date(entry.arrivedAt).getTime() >= cutoff) return false;
    if (entry.kind === "email") return entry.items.every((item) => canUndoIgnore(item));
    return entry.kind === "capture" && canUndoIgnore(entry.item);
  });
}

/** "oldest: 6 weeks" for the oldest waiting email or capture, once it is a week old; otherwise null. */
export function oldestLabel(entries: readonly QueueEntry[], now: Date): string | null {
  let oldest = Infinity;
  for (const entry of entries) {
    const at = entry.arrivedAt ? new Date(entry.arrivedAt).getTime() : NaN;
    if (!Number.isNaN(at) && at < oldest) oldest = at;
  }
  if (!Number.isFinite(oldest)) return null;
  const weeks = Math.floor((now.getTime() - oldest) / (7 * DAY_MS));
  return weeks < 1 ? null : `oldest: ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}
