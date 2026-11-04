/**
 * The rows of the "Welcome back" banner and sheet (gap review 2026-10-27, G1 and G12). Pure: counts and clocks
 * in, rows out, so the hook that reads the portal and the screen that draws it share one rule for what
 * is worth showing and how it is worded.
 */
export type WelcomeBackKey = "catch-up" | "needs" | "agent-changes" | "inbox" | "connections";

export interface WelcomeBackRow {
  key: WelcomeBackKey;
  label: string;
  count: number;
  href: string;
}

/** Where each row opens. Agent changes live under Plan > Review (`placeTabs.plan` in app-nav-tabs.ts), scrolled to. */
export const WELCOME_BACK_HREFS: Record<WelcomeBackKey, string> = {
  "catch-up": "/catch-up",
  needs: "/",
  "agent-changes": "/review#agent-changes",
  inbox: "/inbox",
  connections: "/connections"
};

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export interface WelcomeBackInput {
  /** Unsettled catch-up entries. */
  catchUp: number;
  /** Things the person is needed for, read from NowAnswer `needs` once the trust thread's freshness PR ships; 0 until then. */
  needs: number;
  /** Agent writes made after `lastSeenAt`. */
  agentChanges: number;
  /** Open Inbox items, the number on the Inbox badge. */
  inbox: number;
  /** Labels of connections whose last recorded run failed ("roster sign-in has lapsed"). Recorded state only. */
  lapsedConnections?: readonly string[];
}

/** Rows with something in them, in the order the person should work through them. */
export function welcomeBackRows(input: WelcomeBackInput): WelcomeBackRow[] {
  const rows: Omit<WelcomeBackRow, "href">[] = [
    {
      key: "catch-up",
      count: input.catchUp,
      label: `${input.catchUp} ${plural(input.catchUp, "thing", "things")} to settle`
    },
    {
      key: "needs",
      count: input.needs,
      label: `${input.needs} ${plural(input.needs, "thing", "things")} the plan needs to know`
    },
    {
      key: "agent-changes",
      count: input.agentChanges,
      label: `${input.agentChanges} ${plural(input.agentChanges, "change", "changes")} by ${plural(input.agentChanges, "an agent", "agents")} while you were away`
    },
    { key: "inbox", count: input.inbox, label: `${input.inbox} waiting in Inbox` }
  ];
  const lapsed = input.lapsedConnections ?? [];
  if (lapsed.length > 0)
    rows.unshift({
      key: "connections",
      count: lapsed.length,
      label: lapsed.length === 1 ? (lapsed[0] ?? "") : `${lapsed.length} connections need attention`
    });
  return rows.filter((row) => row.count > 0).map((row) => ({ ...row, href: WELCOME_BACK_HREFS[row.key] }));
}

const HOUR_MS = 3_600_000;

/** Whole milliseconds since `lastSeenAt`, or null when it was never set or does not parse. */
export function awayMs(lastSeenAt: string | null, now: Date): number | null {
  if (!lastSeenAt) return null;
  const seen = Date.parse(lastSeenAt);
  return Number.isNaN(seen) ? null : now.getTime() - seen;
}

/**
 * Agent changes after `lastSeenAt`. With no `lastSeenAt` there is no "since", so none count: a first
 * visit is not a return. Undone and superseded writes are history, not news.
 */
export function agentChangesSince(
  changes: readonly { at: string; status: "applied" | "undone" | "superseded" }[],
  lastSeenAt: string | null
): number {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  if (Number.isNaN(seen)) return 0;
  return changes.filter((change) => change.status === "applied" && Date.parse(change.at) > seen).length;
}

/**
 * Agent changes since the person last looked at the list. Unlike {@link agentChangesSince}, never
 * having looked counts every applied write: those are exactly the ones nobody has seen.
 */
export function agentChangesUnseen(
  changes: readonly { at: string; status: "applied" | "undone" | "superseded" }[],
  lookedAt: string | null
): number {
  const looked = lookedAt ? Date.parse(lookedAt) : Number.NaN;
  return changes.filter(
    (change) => change.status === "applied" && (Number.isNaN(looked) || Date.parse(change.at) > looked)
  ).length;
}

/**
 * Show the banner when a catch-up is due and this device has not marked it seen since the catch-up
 * window opened (`catchUpSince`), or when anything is waiting and the person has been away at least
 * `afterHours` since they last marked it seen. "Not now" therefore hides a due catch-up until the next
 * window opens or another long absence, rather than the banner coming straight back.
 */
export function showWelcomeBack(input: {
  catchUpDue: boolean;
  catchUpSince: string | null;
  rows: readonly WelcomeBackRow[];
  lastSeenAt: string | null;
  now: Date;
  afterHours: number;
}): boolean {
  const away = awayMs(input.lastSeenAt, input.now);
  if (input.catchUpDue && !seenSince(input.lastSeenAt, input.catchUpSince)) return true;
  if (input.rows.length === 0) return false;
  return away !== null && away >= input.afterHours * HOUR_MS;
}

/** True when `lastSeenAt` is at or after `since`; a null `since` (nothing ever recorded) counts as seen once anything was marked. */
function seenSince(lastSeenAt: string | null, since: string | null): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return false;
  if (!since) return true;
  const opened = Date.parse(since);
  return Number.isNaN(opened) || seen >= opened;
}

/** The later of when this device was last marked seen and when anything was last recorded, else null. */
export function awaySince(lastSeenAt: string | null, catchUpSince: string | null): string | null {
  const times = [lastSeenAt, catchUpSince].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}
