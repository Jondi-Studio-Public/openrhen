import type { ConsequenceGroupView, RankConsequenceGroupCommand } from "@openrhen/contracts";

/**
 * The pure part of the "Rank these four" card: ordering, the answer commands, what each item says about where it sits,
 * and the per-device count of answered groups behind the progress line. Nothing here touches the network or React.
 */

/** Groups offered per local day before the card asks whether to go on (a soft prompt; the server enforces nothing). */
export const DAILY_GROUPS = 3;
/** Days the card remembers answers for, so the weekly line has a week and storage stays tiny. */
const KEEP_DAYS = 14;
export const STORAGE_KEY = "openrhen:consequence-rank-answers";

/** Moves the item at `from` to `to` (both clamped to the list); returns the same array when nothing moves. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (from < 0 || from >= items.length || from === target) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/**
 * Where a dragged item should land: the index of the row whose vertical midpoint the pointer has passed, counting
 * rows in their current order. `midpoints` are the rows' vertical centres, top to bottom.
 */
export function dropIndex(midpoints: readonly number[], pointerY: number): number {
  let index = 0;
  for (const midpoint of midpoints) if (pointerY > midpoint) index += 1;
  return Math.min(index, Math.max(0, midpoints.length - 1));
}

/** "Position 2 of 4", for the live announcement after an item moves. */
export function positionLabel(title: string, index: number, total: number): string {
  return `${title} is now number ${index + 1} of ${total}`;
}

/** Ids best first, from the order on screen. */
export function orderedIds(order: readonly { id: string }[]): string[] {
  return order.map((item) => item.id);
}

/** The ranked answer: every id of the group once, best first. The server forces a person's basis to `stated`. */
export function rankCommand(
  group: ConsequenceGroupView,
  order: readonly { id: string }[],
  commandId: string
): RankConsequenceGroupCommand {
  return { commandId, groupId: group.groupId, rankedIds: orderedIds(order), wording: group.wording };
}

/** Equal or cannot decide: a tie records no preference. */
export function tieCommand(group: ConsequenceGroupView, commandId: string): RankConsequenceGroupCommand {
  return { commandId, groupId: group.groupId, tie: true, wording: group.wording };
}

/** Skip is a tie that says so, the same call `rhen rank --skip` makes, so the group cools without counting as an answer. */
export function skipCommand(group: ConsequenceGroupView, commandId: string): RankConsequenceGroupCommand {
  return { ...tieCommand(group, commandId), evidence: "skipped" };
}

/** The parent line under an item: a project sits in its outcome; an action names its project. */
export interface ItemContext {
  parent: string | null;
}
export function itemContext(
  group: ConsequenceGroupView,
  item: { id: string },
  plan: {
    outcomes: readonly { id: string; title: string }[];
    projects: readonly { id: string; title: string; outcomeId?: string | undefined }[];
    actions: readonly { id: string; projectId: string }[];
  }
): ItemContext {
  if (group.pool === "action") {
    const action = plan.actions.find((entry) => entry.id === item.id);
    const project = action ? plan.projects.find((entry) => entry.id === action.projectId) : undefined;
    return { parent: project?.title ?? null };
  }
  const project = plan.projects.find((entry) => entry.id === item.id);
  const outcome = project?.outcomeId ? plan.outcomes.find((entry) => entry.id === project.outcomeId) : undefined;
  return { parent: outcome?.title ?? null };
}

export function starsText(stars: number): string {
  const whole = Math.max(0, Math.min(5, Math.round(stars)));
  return "★".repeat(whole) + "☆".repeat(5 - whole);
}

/** What the card is called for the pool in hand. */
export function poolNoun(group: ConsequenceGroupView): string {
  return group.pool === "action" ? "actions" : "projects";
}

/** The cap on a group's size that the heading can promise ("Rank these four"). */
export function groupHeading(group: ConsequenceGroupView): string {
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  return `Rank these ${words[group.items.length] ?? group.items.length}`;
}

/** Answered groups by local day (`YYYY-MM-DD`), newest last. Ranked and equal answers count; a skip does not. */
export type AnswerLog = string[];

export function readAnswerLog(storage: Pick<Storage, "getItem"> | null): AnswerLog {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === "string") : [];
  } catch {
    return [];
  }
}

export function writeAnswerLog(storage: Pick<Storage, "setItem"> | null, log: AnswerLog): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    // The count is a convenience; the card works without storage.
  }
}

/** Adds an answer for `day` and drops anything older than the kept window. */
export function addAnswer(log: AnswerLog, day: string): AnswerLog {
  return [...log, day]
    .sort()
    .slice(-200)
    .filter((entry) => dayDistance(day, entry) < KEEP_DAYS);
}

function dayDistance(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

export function answeredOn(log: AnswerLog, day: string): number {
  return log.filter((entry) => entry === day).length;
}

/** Answers in the seven local days ending `day`. */
export function answeredThisWeek(log: AnswerLog, day: string): number {
  return log.filter((entry) => {
    const distance = dayDistance(day, entry);
    return distance >= 0 && distance < 7;
  }).length;
}

/** The progress line, with the reminder that every answer is optional. */
export function progressLine(today: number, week: number): string {
  if (week === 0)
    return "None answered on this device yet. Every answer is optional; plans work the same without them.";
  const groups = (count: number) => `${count} ${count === 1 ? "group" : "groups"}`;
  return `${groups(today)} today, ${groups(week)} this week. Every answer is optional; a few a week is plenty.`;
}

/** True when the day's suggested groups are done and the card should ask before going on. */
export function pausedForToday(today: number, more: boolean): boolean {
  return today >= DAILY_GROUPS && !more;
}
