/** How far back a room's "Recently handled" list reaches, in days. */
export const HANDLED_WINDOW_DAYS = 7;

/** One line in a "Recently handled" list: what it was, what happened to it, and when. */
export interface HandledRow {
  id: string;
  title: string;
  /** The kind and any other context, shown under the title. */
  detail: string;
  /** The outcome, shown as a pill: confirmed, ignored, accepted, dismissed and so on. */
  outcome: string;
  /** An ISO instant; rows are listed newest first. */
  at: string;
}

/** Whether an instant falls in the last seven days. An unreadable or missing one does not. */
export function isWithinHandledWindow(at: string | null | undefined, now: number): boolean {
  if (!at) return false;
  const time = new Date(at).getTime();
  if (Number.isNaN(time)) return false;
  return time >= now - HANDLED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export function newestFirst(rows: readonly HandledRow[]): HandledRow[] {
  return rows.slice().sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
