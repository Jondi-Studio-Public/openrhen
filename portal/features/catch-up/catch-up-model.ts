import type {
  CatchUpEntry,
  CatchUpEntryKind,
  CatchUpLedger,
  CatchUpVerdictName,
  SettleCatchUpCommand
} from "@openrhen/contracts";
import { localDayKey } from "@/features/today/today-view";
import { zonedWallTimeOnDay } from "@/features/today/local-datetime";

/** What the person decided for one entry. `pending` is "Keep open": nothing changes (a deadline may be moved). */
export type CatchUpChoice = CatchUpVerdictName;

export interface CatchUpDecisions {
  choices: Record<string, CatchUpChoice>;
  /** A new date for a deadline kept open, as `YYYY-MM-DD`. */
  moveTo: Record<string, string>;
  /** When it happened or stopped, as a `datetime-local` value in the person's zone (verdicts in `atRequired`). */
  at?: Record<string, string>;
  /** `ended` on an action session: minutes of effort still left, as typed. */
  remaining?: Record<string, string>;
  note: string;
}

export const EMPTY_DECISIONS: CatchUpDecisions = { choices: {}, moveTo: {}, note: "" };

/** The verdicts an entry offers: an external date cannot be skipped, because the outcome still has to be dealt with. */
export function choicesFor(kind: CatchUpEntryKind): readonly CatchUpChoice[] {
  return kind === "external_deadline" ? ["done", "dropped", "pending"] : ["done", "skipped", "dropped", "pending"];
}

export const CHOICE_LABELS: Record<CatchUpChoice, string> = {
  done: "Done",
  ended: "Stopped at",
  skipped: "Skipped",
  dropped: "Dropped",
  pending: "Keep open"
};

/** The words for a choice on a deadline, where skipping clears the date and dropping pauses the project. */
export function choiceLabel(kind: CatchUpEntryKind, choice: CatchUpChoice): string {
  if (kind === "open_session") {
    if (choice === "skipped") return "Didn't start";
    if (choice === "pending") return "Still going";
    return CHOICE_LABELS[choice];
  }
  if (kind === "stale_wake") return choice === "done" ? "Woke at" : "Still open";
  if (kind === "check_in") {
    if (choice === "done") return "On track";
    if (choice === "skipped") return "Not sure";
    return "Still open";
  }
  if (kind === "occurrence") return CHOICE_LABELS[choice];
  if (choice === "skipped") return "Clear date";
  if (choice === "dropped") return "Pause";
  return CHOICE_LABELS[choice];
}

export interface CatchUpProject {
  projectId: string | null;
  entries: CatchUpEntry[];
}
export interface CatchUpDay {
  /** `YYYY-MM-DD` in the person's time zone. */
  day: string;
  projects: CatchUpProject[];
}

/** Kinds about the present moment rather than a day: listed first, in "Right now". */
export const RIGHT_NOW_KINDS: readonly CatchUpEntryKind[] = ["open_session", "stale_wake", "check_in"];

export function rightNowEntries(entries: readonly CatchUpEntry[]): CatchUpEntry[] {
  return entries.filter((entry) => RIGHT_NOW_KINDS.includes(entry.kind));
}

export function entryDay(entry: CatchUpEntry, timezone: string): string {
  return entry.localDate ?? localDayKey(new Date(entry.plannedAt), timezone);
}

/** Days newest first, each grouped by project in first-seen order. */
export function groupEntries(entries: readonly CatchUpEntry[], timezone: string): CatchUpDay[] {
  const days = new Map<string, Map<string, CatchUpProject>>();
  for (const entry of entries) {
    if (RIGHT_NOW_KINDS.includes(entry.kind)) continue;
    const day = entryDay(entry, timezone);
    const projects = days.get(day) ?? new Map<string, CatchUpProject>();
    const key = entry.projectId ?? "";
    const project = projects.get(key) ?? { projectId: entry.projectId, entries: [] };
    project.entries.push(entry);
    projects.set(key, project);
    days.set(day, projects);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, projects]) => ({ day, projects: [...projects.values()] }));
}

/** Sets one choice on every entry in a group that offers it (an external date has no "skipped"). */
export function applyToEntries(
  decisions: CatchUpDecisions,
  entries: readonly CatchUpEntry[],
  choice: CatchUpChoice
): CatchUpDecisions {
  const choices = { ...decisions.choices };
  for (const entry of entries) if (entry.verdicts.includes(choice)) choices[entry.id] = choice;
  return { ...decisions, choices };
}

export function setChoice(
  decisions: CatchUpDecisions,
  entryId: string,
  choice: CatchUpChoice | null
): CatchUpDecisions {
  const { [entryId]: _removed, ...rest } = decisions.choices;
  return { ...decisions, choices: choice === null ? rest : { ...rest, [entryId]: choice } };
}

export function setMoveTo(decisions: CatchUpDecisions, entryId: string, day: string): CatchUpDecisions {
  const { [entryId]: _removed, ...rest } = decisions.moveTo;
  return { ...decisions, moveTo: day ? { ...rest, [entryId]: day } : rest };
}

/** Sets or clears the time given for an entry (empty clears it). */
export function setAt(decisions: CatchUpDecisions, entryId: string, value: string): CatchUpDecisions {
  const { [entryId]: _removed, ...rest } = decisions.at ?? {};
  return { ...decisions, at: value ? { ...rest, [entryId]: value } : rest };
}

export function setRemaining(decisions: CatchUpDecisions, entryId: string, value: string): CatchUpDecisions {
  const { [entryId]: _removed, ...rest } = decisions.remaining ?? {};
  return { ...decisions, remaining: value ? { ...rest, [entryId]: value } : rest };
}

/** The `datetime-local` value (`YYYY-MM-DDTHH:mm`) for an instant, in the person's zone. */
export function instantToLocalInput(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: timezone }).slice(0, 16).replace(" ", "T");
}

/** The instant a `datetime-local` value means in the person's zone, as an ISO string. */
export function localInputToInstant(value: string, timezone: string): string {
  const [day = "", time = "00:00"] = value.split("T");
  return zonedWallTimeOnDay(day, time.slice(0, 5), timezone).toISOString();
}

/** What an `at` starts as: the entry's planned time for a session, now for the wake (never in the future). */
export function defaultAt(entry: CatchUpEntry, now: Date, timezone: string): string {
  const planned = new Date(entry.plannedAt);
  const instant = entry.kind === "open_session" && planned.getTime() < now.getTime() ? planned : now;
  return instantToLocalInput(instant.toISOString(), timezone);
}

export function skipOlderThanCommand(days: number, commandId: string): SettleCatchUpCommand {
  return {
    commandId,
    verdicts: [{ bulk: "skip_older_than", days }],
    closeWindow: false,
    basis: "inferred"
  };
}

/** Drops decisions about entries the ledger no longer lists (settled elsewhere, or a stale saved draft). */
export function pruneDecisions(decisions: CatchUpDecisions, entries: readonly CatchUpEntry[]): CatchUpDecisions {
  const ids = new Set(entries.map((entry) => entry.id));
  const keep = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  return {
    choices: keep(decisions.choices),
    moveTo: keep(decisions.moveTo),
    at: keep(decisions.at ?? {}),
    remaining: keep(decisions.remaining ?? {}),
    note: decisions.note
  };
}

/** Entries with a choice that changes something; "Keep open" with no new date leaves the entry listed. */
export function decidedEntries(decisions: CatchUpDecisions, entries: readonly CatchUpEntry[]): CatchUpEntry[] {
  return entries.filter((entry) => {
    const choice = decisions.choices[entry.id];
    if (!choice) return false;
    if (entry.atRequired.includes(choice) && !decisions.at?.[entry.id]) return false;
    return choice !== "pending" || Boolean(decisions.moveTo[entry.id]);
  });
}

/** Local noon on a calendar day, so the new date lands inside that day in any zone near the person's. */
function dayToInstant(day: string, timezone: string): string {
  const guess = new Date(`${day}T12:00:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (utc.getTime() - local.getTime())).toISOString();
}

export function buildSettleCommand(
  decisions: CatchUpDecisions,
  entries: readonly CatchUpEntry[],
  options: { commandId: string; timezone: string; closeWindow: boolean }
): SettleCatchUpCommand | null {
  const decided = decidedEntries(decisions, entries);
  if (decided.length === 0) return null;
  const verdicts: SettleCatchUpCommand["verdicts"] = decided.map((entry) => {
    const choice = decisions.choices[entry.id]!;
    const moveTo = decisions.moveTo[entry.id];
    const at = decisions.at?.[entry.id];
    const left = Number(decisions.remaining?.[entry.id]);
    return {
      entryId: entry.id,
      verdict: choice,
      ...(entry.version !== null ? { version: entry.version } : {}),
      ...(at && entry.atRequired.includes(choice) ? { at: localInputToInstant(at, options.timezone) } : {}),
      ...(choice === "ended" &&
      entry.asksRemainingMinutes &&
      decisions.remaining?.[entry.id] &&
      Number.isInteger(left) &&
      left >= 0
        ? { remainingMinutes: left }
        : {}),
      ...(choice === "pending" && moveTo ? { moveTo: dayToInstant(moveTo, options.timezone) } : {}),
      ...(choice === "dropped" && entry.kind !== "occurrence" ? { becomes: "paused" as const } : {})
    };
  });
  const note = decisions.note.trim();
  return {
    commandId: options.commandId,
    verdicts,
    closeWindow: options.closeWindow,
    // Only an agent's settle is judged by its basis; the person's applies whatever it says.
    basis: "inferred",
    ...(note ? { note: note.slice(0, 2000) } : {})
  };
}

/** Whether a catch-up is due: the server says so and something is still unsettled. Read by welcome-back. */
export function showBanner(ledger: CatchUpLedger | null): boolean {
  return ledger !== null && ledger.due && ledger.unsettled > 0;
}
