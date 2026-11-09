/**
 * The drift detector: rows in, episodes out. Pure, with no I/O and no clock read. A drift is a moment the person
 * stopped doing what the plan sanctioned; however many signals saw it, it is one `DriftEpisode`.
 *
 * Only measurement lives here. Nothing in `engine/`, `now-activity.ts` or `plan-input-tables.json` may import or read
 * drift output (see `drift-boundary.test.ts`), so a detection never reorders what the plan offers. The module is
 * deliberately not re-exported from the contracts barrel: it has its own `@openrhen/contracts/drift` entry. See
 * docs/architecture/drift.md.
 */

/** The drift types, each with the signal that defines it. `activity_mismatch` is held back, see the doc. */
export const DRIFT_TYPES = ["deviated_checkin", "unsanctioned_session"] as const;
export type DriftType = (typeof DRIFT_TYPES)[number];

/** The raw signals an episode can hold as evidence. A session ending is extra evidence on its start, not a second drift. */
export const DRIFT_SIGNALS = ["checkin_deviated", "session_started", "session_ended"] as const;
export type DriftSignal = (typeof DRIFT_SIGNALS)[number];

/** Which signal makes an episode of each type (a session start leads when both are present). */
const PRIMARY_SIGNAL: Readonly<Record<DriftType, DriftSignal>> = {
  deviated_checkin: "checkin_deviated",
  unsanctioned_session: "session_started"
};

/** Signals that fall this many minutes before or after one drift's span are the same drift. */
export const DRIFT_COLLAPSE_WINDOW_MINUTES = 10;
/**
 * A time is pinned when the system knew it within this many minutes of when it happened. A session started at a
 * chosen past moment is recorded later (`startedRecordedAt`), so its time is not pinned.
 */
export const DRIFT_PINNED_SLACK_MINUTES = 2;

/** A check-in answered by reconciling a session after the fact: the answer arrives long after the moment. */
const RECONCILED_ANSWER_SOURCE = "session_reconciliation";

export interface DriftCheckInRow {
  id: string;
  /** `check_in.status`; only `deviated` is a drift. */
  status: string;
  answeredAt: Date | null;
  answerSource: string | null;
  /** The agent that answered; a person's own answer has none. */
  answeredBy: string | null;
}

export interface DriftSessionRow {
  id: string;
  /** `sessions.status`; a `planned` session has not started and is never a drift. */
  status: string;
  startedAt: Date | null;
  /** When a start at a past moment was actually recorded; null when the session started at its own time. */
  startedRecordedAt: Date | null;
  endedAt: Date | null;
  endedRecordedAt: Date | null;
  /** `sessions.plan_sanction`; null means unsanctioned when the session started, or a row older than the column. */
  planSanction: string | null;
  createdAt: Date;
}

export interface DriftInput {
  checkIns: readonly DriftCheckInRow[];
  sessions: readonly DriftSessionRow[];
  /**
   * Sessions created before this instant are skipped: a null `plan_sanction` there means "predates the column", not
   * "unsanctioned". Absent: every null counts as unsanctioned, which overcounts on a database that holds old rows.
   */
  legacyBefore?: Date | null;
  /** Keep only episodes that happened in `[from, to)`. Rows just outside still take part in collapsing. */
  window?: { from: Date; to: Date };
}

export interface DriftEvidence {
  signal: DriftSignal;
  /** The check-in or session id. */
  id: string;
  at: Date;
}

export interface DriftEpisode {
  /** Stable for the same rows: `<type>:<primary evidence id>`. */
  id: string;
  type: DriftType;
  /** When the drift happened. */
  occurredAt: Date;
  /** When the system first knew: the recorded time of a backdated session, else `occurredAt`. */
  knownAt: Date;
  /** True only when `occurredAt` was recorded live. Unpinned episodes never count toward lead-time recall or a go/no-go. */
  pinned: boolean;
  evidence: DriftEvidence[];
}

const MINUTE = 60_000;

interface Candidate {
  type: DriftType;
  occurredAt: Date;
  knownAt: Date;
  /** The span the drift covers, used to decide which signals are the same drift. */
  spanStart: number;
  spanEnd: number;
  evidence: DriftEvidence[];
}

function latest(a: Date, b: Date | null): Date {
  return b && b.getTime() > a.getTime() ? b : a;
}

function sessionCandidate(session: DriftSessionRow, input: DriftInput): Candidate | null {
  if (session.status === "planned" || !session.startedAt || session.planSanction !== null) return null;
  if (input.legacyBefore && session.createdAt.getTime() < input.legacyBefore.getTime()) return null;
  const startedAt = session.startedAt;
  const evidence: DriftEvidence[] = [{ signal: "session_started", id: session.id, at: startedAt }];
  let knownAt = latest(startedAt, session.startedRecordedAt);
  let spanEnd = startedAt.getTime();
  if (session.endedAt) {
    evidence.push({ signal: "session_ended", id: session.id, at: session.endedAt });
    knownAt = latest(knownAt, session.endedRecordedAt);
    spanEnd = session.endedAt.getTime();
  }
  return {
    type: "unsanctioned_session",
    occurredAt: startedAt,
    knownAt,
    spanStart: startedAt.getTime(),
    spanEnd,
    evidence
  };
}

/** A person's own deviated answer, given outside a running session. */
function checkInSignal(row: DriftCheckInRow, sessions: readonly DriftSessionRow[]): DriftEvidence | null {
  if (row.status !== "deviated" || !row.answeredAt) return null;
  if (row.answerSource === RECONCILED_ANSWER_SOURCE || row.answeredBy !== null) return null;
  const at = row.answeredAt.getTime();
  // Inside a session the evidence is what the session itself shows, not an answer.
  const inside = sessions.some(
    (session) =>
      session.status !== "planned" &&
      session.startedAt !== null &&
      session.startedAt.getTime() <= at &&
      (session.endedAt === null || at < session.endedAt.getTime())
  );
  return inside ? null : { signal: "checkin_deviated", id: row.id, at: row.answeredAt };
}

/** Episodes in the order they happened. */
export function detectDriftEpisodes(input: DriftInput): DriftEpisode[] {
  const candidates = input.sessions.flatMap((session) => sessionCandidate(session, input) ?? []);
  const reach = DRIFT_COLLAPSE_WINDOW_MINUTES * MINUTE;
  const loose: Candidate[] = [];
  for (const row of input.checkIns) {
    const signal = checkInSignal(row, input.sessions);
    if (!signal) continue;
    const at = signal.at.getTime();
    const into = candidates.find((candidate) => at >= candidate.spanStart - reach && at <= candidate.spanEnd + reach);
    if (into) {
      into.evidence.push(signal);
      continue;
    }
    loose.push({
      type: "deviated_checkin",
      occurredAt: signal.at,
      knownAt: signal.at,
      spanStart: at,
      spanEnd: at,
      evidence: [signal]
    });
  }
  const slack = DRIFT_PINNED_SLACK_MINUTES * MINUTE;
  const episodes = [...candidates, ...loose].map((candidate): DriftEpisode => {
    const primary = candidate.evidence.find((item) => item.signal === PRIMARY_SIGNAL[candidate.type]);
    const pinned =
      candidate.type === "unsanctioned_session" &&
      candidate.knownAt.getTime() - candidate.occurredAt.getTime() <= slack;
    return {
      id: `${candidate.type}:${primary?.id ?? ""}`,
      type: candidate.type,
      occurredAt: candidate.occurredAt,
      knownAt: candidate.knownAt,
      pinned,
      evidence: [...candidate.evidence].sort((a, b) => a.at.getTime() - b.at.getTime())
    };
  });
  const window = input.window;
  return episodes
    .filter(
      (episode) =>
        !window ||
        (episode.occurredAt.getTime() >= window.from.getTime() && episode.occurredAt.getTime() < window.to.getTime())
    )
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
}

export interface DriftCounts {
  /** Episodes, all types. */
  episodes: number;
  /** Pinned episodes: the only ones a go/no-go count or lead-time recall may use. */
  pinned: number;
  /** Per primary type. */
  byType: Record<DriftType, { episodes: number; pinned: number }>;
  /** Per raw signal, secondary to the episode counts: an episode of several signals counts once in `episodes`. */
  bySignal: Record<DriftSignal, number>;
}

/** Counts of episodes, per primary type, with the per-signal counts beside them. */
export function countDriftEpisodes(episodes: readonly DriftEpisode[]): DriftCounts {
  const counts: DriftCounts = {
    episodes: episodes.length,
    pinned: 0,
    byType: Object.fromEntries(DRIFT_TYPES.map((type) => [type, { episodes: 0, pinned: 0 }])) as DriftCounts["byType"],
    bySignal: Object.fromEntries(DRIFT_SIGNALS.map((signal) => [signal, 0])) as DriftCounts["bySignal"]
  };
  for (const episode of episodes) {
    counts.byType[episode.type].episodes += 1;
    if (episode.pinned) {
      counts.pinned += 1;
      counts.byType[episode.type].pinned += 1;
    }
    for (const item of episode.evidence) counts.bySignal[item.signal] += 1;
  }
  return counts;
}
