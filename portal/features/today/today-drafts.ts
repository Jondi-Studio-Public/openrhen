import {
  commitmentRepeatFallsOn,
  normalizeRepeatWeekdays,
  type CommitmentRepeatUnit,
  type MonthAnchor,
  type SaveCommitmentRecurrenceRuleCommand,
  type TransportMode
} from "@openrhen/contracts";
import type { PlanningSettings, StoredCommitment, StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import { dateInput, iso } from "./local-datetime";

/**
 * The one commitment editor's draft: a single shape holding both what a one-off commitment needs
 * and what a repeating rule needs, switched by `repeats`. Only the half the toggle selects is ever
 * validated or sent; the other half just keeps its defaults. `repeats` is fixed once saved — a
 * stored one-off cannot become a series, nor a series a one-off.
 */
export interface CommitmentEditorDraft {
  id: string;
  repeats: boolean;
  title: string;
  projectId: string;
  /** The display label, written from the chosen place's name; there is no free-text input for it. */
  location: string;
  /** The location context it happens at. */
  locationId: string;
  startsAt: string;
  endsAt: string;
  status: StoredCommitment["status"];
  startDate: string;
  localStartTime: string;
  localEndTime: string;
  /** "days" (the plain interval, as before), "weeks" (on listed weekdays) or "months" (anchored to `startDate`). */
  repeatUnit: CommitmentRepeatUnit;
  intervalDays: number;
  /** Weeks branch only. */
  intervalWeeks: number;
  /** Weeks branch only; 0 = Sunday .. 6 = Saturday. The start date's weekday is always included when sent. */
  weekdays: number[];
  /** Months branch only. */
  intervalMonths: number;
  /** Months branch only; must be one the current `startDate` actually satisfies — see `monthAnchorOptions`. */
  monthAnchor: MonthAnchor;
  /** The rule's optional last date, kept as "" while the series is open-ended. */
  endDate: string;
  ruleStatus: "active" | "ended";
  setupBeforeMinutes: number;
  transitionAfterMinutes: number;
  /** Whether the time is taken outright, or only the place is. Both halves of the editor use it. */
  presence: NonNullable<StoredCommitment["presence"]>;
  /** Whether this publishes to the household calendar. Both halves of the editor use it. */
  shareToCalendar: boolean;
  /**
   * How eagerly the check-in scheduler prompts while this is the active commitment. Only a stored
   * one-off commitment carries it — a repeating rule has no row of its own to hold it, so each
   * materialized occurrence keeps whatever it was individually set to (or the 'normal' default).
   */
  promptPolicy: NonNullable<StoredCommitment["promptPolicy"]>;
  /**
   * Whether a late arrival matters. Both halves of
   * the editor use it: an occurrence's own field, or the rule's, copied onto each occurrence at
   * materialisation. On by default.
   */
  latenessMatters: boolean;
  /**
   * How this is reached: "" reads as "usual" — no opinion here, so `resolveMode` falls to the
   * place's usual mode, then the user's default. Both halves of the editor use it.
   */
  transportMode: TransportMode | "";
  /**
   * The slug of a `condition_definitions` row of kind `contact`, chosen the same way `locationId`
   * names a place. "" means no contact, and — unlike
   * `locationId` — is always sent rather than omitted, because it is the explicit way to clear a
   * previously chosen contact back to none.
   */
  contactId: string;
  /** Pulse privacy: effective privacy is
      this OR the recurrence rule's, for both a one-off commitment and a repeating series alike. */
  private: boolean;
  /**
   * Whether the person goes there or joins from wherever they are (`CONTEXT.md` "Attendance"). A remote
   * commitment plans no travel. One-off commitments and occurrences only: a series has no place to hold it.
   */
  attendance: "in_person" | "remote";
  /** Remote only: where the person would like to join from, a preference the planner never requires. */
  preferredLocationId: string;
  /**
   * Pulse check-in allowance: extra minutes before a missed check-in turns
   * "not sure" into "off plan" while this is in force. Null is the default (+15); 0 and up is a custom value.
   * Both halves of the editor use it: a series' own value, or an occurrence's.
   */
  checkInExtraMinutes: number | null;
}

export const emptyCommitmentEditor = (settings: PlanningSettings): CommitmentEditorDraft => ({
  id: "",
  repeats: false,
  title: "",
  projectId: "",
  location: "",
  locationId: "",
  startsAt: "",
  endsAt: "",
  status: "confirmed",
  startDate: "",
  localStartTime: "09:00",
  localEndTime: "10:00",
  repeatUnit: "days",
  intervalDays: 7,
  intervalWeeks: 1,
  weekdays: [],
  intervalMonths: 1,
  monthAnchor: "day_of_month",
  endDate: "",
  ruleStatus: "active",
  setupBeforeMinutes: settings.defaultSetupBufferMinutes,
  transitionAfterMinutes: settings.defaultTransitionBufferMinutes,
  presence: "blocking",
  shareToCalendar: false,
  promptPolicy: "normal",
  latenessMatters: true,
  transportMode: "",
  contactId: "",
  private: false,
  attendance: "in_person",
  preferredLocationId: "",
  checkInExtraMinutes: null
});

/** A defaults base for the half of the editor a loaded record does not fill. */
const editorDefaults = (settings: PlanningSettings) => emptyCommitmentEditor(settings);

export const commitmentEditorFrom = (item: StoredCommitment, settings: PlanningSettings): CommitmentEditorDraft => ({
  ...editorDefaults(settings),
  id: item.id,
  repeats: false,
  title: item.title,
  projectId: item.projectId ?? "",
  location: item.location ?? "",
  locationId: item.locationId ?? "",
  startsAt: dateInput(item.startsAt, settings.timezone),
  endsAt: dateInput(item.endsAt, settings.timezone),
  status: item.status,
  setupBeforeMinutes: item.setupBeforeMinutes,
  transitionAfterMinutes: item.transitionAfterMinutes,
  presence: item.presence ?? "blocking",
  shareToCalendar: item.shareToCalendar ?? false,
  promptPolicy: item.promptPolicy ?? "normal",
  latenessMatters: item.latenessMatters ?? true,
  transportMode: item.transportMode ?? "",
  contactId: item.contactId ?? "",
  private: item.private ?? false,
  attendance: item.attendance ?? "in_person",
  preferredLocationId: item.preferredLocationId ?? "",
  checkInExtraMinutes: item.checkInExtraMinutes ?? null
});

/** 0 = Sunday .. 6 = Saturday for a `YYYY-MM-DD` date, or null while it is blank or malformed. */
export const weekdayOfDate = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00Z`).getUTCDay();
};

/** The weekly rule a draft describes: its ticked days plus the start date's own weekday. */
const weeksRepeatFrom = (draft: CommitmentEditorDraft) => {
  const startDay = weekdayOfDate(draft.startDate);
  return {
    unit: "weeks" as const,
    intervalWeeks: draft.intervalWeeks,
    weekdays: normalizeRepeatWeekdays(startDay === null ? draft.weekdays : [...draft.weekdays, startDay])
  };
};

export const commitmentEditorFromRule = (
  item: StoredCommitmentRecurrenceRule,
  settings: PlanningSettings
): CommitmentEditorDraft => ({
  ...editorDefaults(settings),
  id: item.id,
  repeats: true,
  title: item.title,
  projectId: item.projectId ?? "",
  location: item.location ?? "",
  locationId: item.locationId ?? "",
  startDate: item.startDate,
  localStartTime: item.localStartTime,
  localEndTime: item.localEndTime,
  repeatUnit: item.repeat.unit,
  intervalDays: item.repeat.unit === "days" ? item.repeat.intervalDays : 7,
  intervalWeeks: item.repeat.unit === "weeks" ? item.repeat.intervalWeeks : 1,
  weekdays: item.repeat.unit === "weeks" ? [...item.repeat.weekdays] : [],
  intervalMonths: item.repeat.unit === "months" ? item.repeat.intervalMonths : 1,
  monthAnchor: item.repeat.unit === "months" ? item.repeat.anchor : "day_of_month",
  endDate: item.endDate ?? "",
  ruleStatus: item.status,
  setupBeforeMinutes: item.setupBeforeMinutes,
  transitionAfterMinutes: item.transitionAfterMinutes,
  presence: item.presence ?? "blocking",
  shareToCalendar: item.shareToCalendar ?? false,
  latenessMatters: item.latenessMatters ?? true,
  transportMode: item.transportMode ?? "",
  contactId: item.contactId ?? "",
  private: item.private ?? false,
  checkInExtraMinutes: item.checkInExtraMinutes ?? null
});

/**
 * The saved shape of a one-off commitment draft. Optional fields are omitted rather than sent
 * empty, both because the contract treats absent and blank differently and because clearing the
 * place (and with it the label it wrote) has to reach the server as an absence.
 */
export const commitmentEntityFrom = (
  draft: CommitmentEditorDraft,
  id: string,
  timezone: string
): Record<string, unknown> => ({
  id,
  title: draft.title.trim(),
  startsAt: iso(draft.startsAt, timezone),
  endsAt: iso(draft.endsAt, timezone),
  status: draft.status,
  setupBeforeMinutes: draft.setupBeforeMinutes,
  transitionAfterMinutes: draft.transitionAfterMinutes,
  presence: draft.presence,
  shareToCalendar: draft.shareToCalendar,
  promptPolicy: draft.promptPolicy,
  latenessMatters: draft.latenessMatters,
  // Always sent, never omitted: "" means "usual" (no opinion), which explicitly clears a previously
  // chosen mode back to it — the occurrence save's own absence-means-no-opinion rule applies only to
  // an omitted field, and this editor always has a definite answer to send.
  transportMode: draft.transportMode || null,
  // Always sent, never omitted, the same reasoning as `transportMode` above: "" is the explicit way
  // to clear a previously chosen contact back to none.
  contactId: draft.contactId,
  private: draft.private,
  // Always sent, like `contactId`: "" clears a preference that no longer applies, and an in-person
  // commitment never keeps one (the server drops it too).
  attendance: draft.attendance,
  preferredLocationId: draft.attendance === "remote" ? draft.preferredLocationId : "",
  // Always sent: null is the explicit way back to the default allowance.
  checkInExtraMinutes: draft.checkInExtraMinutes,
  ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
  ...(draft.locationId ? { locationId: draft.locationId } : {}),
  ...(draft.projectId ? { projectId: draft.projectId } : {})
});

/** The same for the rule that generates repeating commitments; its times are already wall clock. */
export const commitmentRuleFrom = (
  draft: CommitmentEditorDraft,
  id: string,
  timezone: string
): SaveCommitmentRecurrenceRuleCommand["rule"] => ({
  id,
  title: draft.title.trim(),
  timezone,
  startDate: draft.startDate,
  repeat:
    draft.repeatUnit === "months"
      ? { unit: "months", intervalMonths: draft.intervalMonths, anchor: draft.monthAnchor }
      : draft.repeatUnit === "weeks"
        ? weeksRepeatFrom(draft)
        : { unit: "days", intervalDays: draft.intervalDays },
  localStartTime: draft.localStartTime,
  localEndTime: draft.localEndTime,
  setupBeforeMinutes: draft.setupBeforeMinutes,
  transitionAfterMinutes: draft.transitionAfterMinutes,
  presence: draft.presence,
  shareToCalendar: draft.shareToCalendar,
  status: draft.ruleStatus,
  latenessMatters: draft.latenessMatters,
  // Always sent: "" is the explicit `null` that clears a previously chosen mode back to "usual"
  // (`commands.ts`'s `transportMode` is nullable for exactly this).
  transportMode: draft.transportMode || null,
  contactId: draft.contactId,
  private: draft.private,
  checkInExtraMinutes: draft.checkInExtraMinutes,
  ...(draft.endDate ? { endDate: draft.endDate } : {}),
  ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
  ...(draft.locationId ? { locationId: draft.locationId } : {}),
  ...(draft.projectId ? { projectId: draft.projectId } : {})
});

/**
 * **Use the series**: the entity that sets an overridden occurrence back to `scheduleSource:
 * "inherit"`, so the next replan overwrites its title, times, place and buffers from the rule again
 * Every overlay field the rule can write
 * is sent from the stored occurrence unchanged: the server reattaches only when nothing else in the
 * payload differs from the stored row. `revertCommitmentToSeriesCommand` (`commitment-save.ts`) wraps
 * it in the command envelope.
 */
export const revertToSeriesEntity = (commitment: StoredCommitment): Record<string, unknown> => ({
  id: commitment.id,
  title: commitment.title,
  startsAt: commitment.startsAt,
  endsAt: commitment.endsAt,
  status: commitment.status,
  setupBeforeMinutes: commitment.setupBeforeMinutes,
  transitionAfterMinutes: commitment.transitionAfterMinutes,
  shareToCalendar: commitment.shareToCalendar ?? false,
  private: commitment.private ?? false,
  scheduleSource: "inherit",
  ...(commitment.location ? { location: commitment.location } : {}),
  ...(commitment.locationId ? { locationId: commitment.locationId } : {}),
  ...(commitment.projectId ? { projectId: commitment.projectId } : {}),
  ...(commitment.contactId ? { contactId: commitment.contactId } : {})
});

/**
 * What is wrong with a commitment draft, or "" when nothing is. Shared so the quick form on Today
 * and the editor on a commitment's own page refuse the same drafts with the same words: two copies
 * of this drifted the moment one of them grew a rule the other did not.
 */
export const validateCommitmentDraft = (draft: CommitmentEditorDraft): string => {
  if (draft.setupBeforeMinutes < 0 || draft.transitionAfterMinutes < 0) return "Transition buffers cannot be negative.";
  if (draft.repeats) {
    if (!draft.title.trim() || !draft.startDate) return "Recurring commitment title and start date are required.";
    if (draft.localEndTime <= draft.localStartTime) return "A recurring commitment must end after it starts.";
    if (draft.endDate && draft.endDate < draft.startDate)
      return "A recurring commitment cannot end before its first occurrence.";
    if (
      draft.repeatUnit === "months" &&
      !commitmentRepeatFallsOn(
        { unit: "months", intervalMonths: draft.intervalMonths, anchor: draft.monthAnchor },
        draft.startDate,
        draft.startDate
      )
    )
      return "This repeat does not match its own start date.";
    if (draft.repeatUnit === "weeks") {
      if (!Number.isInteger(draft.intervalWeeks) || draft.intervalWeeks < 1)
        return "Repeat every needs a whole number of weeks.";
      const repeat = weeksRepeatFrom(draft);
      if (repeat.weekdays.length === 0 || !commitmentRepeatFallsOn(repeat, draft.startDate, draft.startDate))
        return "This repeat does not match its own start date.";
    }
    return "";
  }
  if (!draft.title.trim() || !draft.startsAt || !draft.endsAt) return "Commitment title, start, and end are required.";
  if (new Date(draft.startsAt) >= new Date(draft.endsAt)) return "A commitment must end after it starts.";
  return "";
};

export const commitmentEditorIsBlank = (draft: CommitmentEditorDraft): boolean =>
  !draft.id && !draft.title && !draft.startsAt && !draft.endsAt && !draft.startDate;

/** Comma-separated context text is what the form holds; the command needs a deduplicated list. */
export const parseContexts = (value: string): string[] => [
  ...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
];

export const hasContext = (value: string, context: string): boolean =>
  value
    .split(",")
    .map((item) => item.trim())
    .includes(context);

export const toggleContext = (value: string, context: string, checked: boolean): string => {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return (checked ? [...new Set([...values, context])] : values.filter((item) => item !== context)).join(", ");
};
