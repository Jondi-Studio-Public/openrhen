import type { ActionStatus, LifecycleStatus, PrerequisiteRef } from "@openrhen/contracts";
import type { StoredAction, StoredArea, StoredDeliverable, StoredOutcome, StoredProject } from "@/state/portal-state";
import { dateInput, dateOnly } from "@/features/plan/plan-formatting";

/**
 * Every Plan editor keeps a draft in page state rather than editing stored records directly, so a
 * half-finished form never reaches the command layer. A draft is all strings and numbers the inputs
 * can hold; turning one into a command lives in `plan-commands.ts`.
 */
// `satisfies` rather than deriving from `lifecycleStatusSchema.options`: this module backs
// client-side Plan editors, and the package's main entry point builds every zod schema at module
// load — see the design notes on why client code imports
// `@openrhen/contracts/readiness` instead. A type-only import still fails the build the moment
// this list and the contract's `LifecycleStatus` diverge, at zero bundle cost.
export const statuses = [
  "active",
  "paused",
  "done",
  "cancelled",
  "archived"
] as const satisfies readonly LifecycleStatus[];
// `satisfies` rather than deriving from `actionStatusSchema.options`: this module backs client-side
// Plan editors, and the package's main entry point builds every zod schema at module load — see
// the design notes on why client code imports
// `@openrhen/contracts/readiness` instead. A type-only import still fails the build the moment
// this list and the contract's `ActionStatus` diverge, at zero bundle cost.
export const actionStatuses = [
  "inbox",
  "planned",
  "active",
  "doing",
  "waiting",
  "blocked",
  "done",
  "cancelled",
  "archived"
] as const satisfies readonly ActionStatus[];

export type AreaDraft = {
  id: string;
  name: string;
  description: string;
  status: StoredArea["status"];
  /** Pulse privacy. */
  private: boolean;
};
export type OutcomeDraft = {
  id: string;
  areaId: string;
  title: string;
  definitionOfDone: string;
  value: number;
  status: StoredOutcome["status"];
  deadlineAt: string;
  reviewOn: string;
};
export type ProjectDraft = {
  id: string;
  outcomeId: string;
  title: string;
  status: StoredProject["status"];
  uncertainty: StoredProject["uncertainty"];
  internalDeadlineAt: string;
  externalDeadlineAt: string;
  consequence: number;
  remainingEffortOverrideMinutes: string;
  /** Prerequisites of any kind; absent leaves the stored ones untouched, empty clears them. */
  prerequisites?: PrerequisiteRef[] | undefined;
  /** Pulse privacy, inherited from the area unless set here — see `AreaDraft.private`. */
  private: boolean;
};
export type ActionDraft = {
  id: string;
  projectId: string;
  title: string;
  status: StoredAction["status"];
  optimisticMinutes: number;
  expectedMinutes: number;
  pessimisticMinutes: number;
  remainingMinutes: number;
  energy: StoredAction["energy"];
  minimumSessionMinutes: number;
  maximumSessionMinutes: number;
  splittable: boolean;
  setupMinutes: number;
  importance: number;
  consequence: number;
  contexts: string;
  pathways: string[][];
  preferences: string[];
  availableFrom: string;
  deadlineAt: string;
  latestStartAt: string;
  dependencyIds: string[];
  /** Prerequisites that are not other actions (the picker splits same-kind ones into `dependencyIds`). */
  prerequisites?: PrerequisiteRef[] | undefined;
  notes: string;
  schedulingMode?: "one_off" | "recurring" | "cadence" | undefined;
  /** A cadence only: how many days apart it is suggested. Ignored once periodUnit is not "interval". */
  intervalDays?: string | undefined;
  /** A cadence only: "interval" keeps the plain intervalDays above; "days"/"month" set a period+target instead. */
  periodUnit?: "interval" | "days" | "month" | undefined;
  /** A cadence, periodUnit "days" only: the rolling window's length in days. */
  periodLength?: string | undefined;
  /** A cadence, periodUnit "days"/"month" only: completions wanted per period. */
  targetOccurrences?: string | undefined;
  /** A cadence only: minimum days between two completions. */
  minSpacingDays?: string | undefined;
  /** A cadence only: weekdays (0 Sunday .. 6 Saturday) this may be suggested on; empty means no restriction. */
  eligibleWeekdays?: number[] | undefined;
  recurrenceStart?: string | undefined;
  recurrenceEnd?: string | undefined;
  morningFallbackStart?: string | undefined;
  morningFallbackEnd?: string | undefined;
  bedtimeFallbackStart?: string | undefined;
  bedtimeFallbackEnd?: string | undefined;
  completionMode?: "end_date" | "total_minutes" | "manual";
  targetTotalMinutes?: string;
  /** Pulse privacy, inherited from the project unless set here — see `AreaDraft.private`. */
  private: boolean;
};
/**
 * A deliverable is registered from an uncontrolled form, so its draft is read out of `FormData`. The
 * same draft carries the planning metadata Plan may later change on a registered deliverable — both
 * deadlines, uncertainty, prerequisite deliverables — because that is where planning metadata lives;
 * the work itself (contract, steps) is authored only in-session.
 */
export type DeliverableDraft = {
  projectId: string;
  title: string;
  externalDeadlineAt: string;
  internalDeadlineAt: string;
  uncertainty: "known" | "some" | "high";
  dependencyIds: string[];
  /** Prerequisites that are not other deliverables. */
  prerequisites?: PrerequisiteRef[] | undefined;
  importance: number;
  consequence: number;
  /** Pulse privacy, inherited from the project unless set here — see `AreaDraft.private`. */
  private: boolean;
};

export const emptyArea = (): AreaDraft => ({ id: "", name: "", description: "", status: "active", private: false });
export const emptyOutcome = (): OutcomeDraft => ({
  id: "",
  areaId: "",
  title: "",
  definitionOfDone: "",
  value: 3,
  status: "active",
  deadlineAt: "",
  reviewOn: ""
});
export const emptyProject = (): ProjectDraft => ({
  id: "",
  outcomeId: "",
  title: "",
  status: "active",
  uncertainty: "some",
  internalDeadlineAt: "",
  externalDeadlineAt: "",
  consequence: 3,
  remainingEffortOverrideMinutes: "",
  prerequisites: [],
  private: false
});
export const emptyAction = (timezone: string): ActionDraft => {
  const start = new Date();
  // 56 calendar days after today in the person's own timezone, not 56 × 24 h of elapsed time: across a
  // daylight-saving change the elapsed-time version lands an hour off, and late in the evening that
  // hour tips the end onto the next calendar date (a 57-day series).
  const recurrenceStart = dateOnly(start, timezone);
  const recurrenceEnd = new Date(Date.parse(`${recurrenceStart}T00:00:00Z`) + 56 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    id: "",
    projectId: "",
    title: "",
    status: "active",
    optimisticMinutes: 5,
    expectedMinutes: 10,
    pessimisticMinutes: 15,
    remainingMinutes: 10,
    energy: "low",
    minimumSessionMinutes: 5,
    maximumSessionMinutes: 15,
    splittable: false,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: "home",
    pathways: [["home"]],
    preferences: [],
    availableFrom: "",
    deadlineAt: "",
    latestStartAt: "",
    dependencyIds: [],
    prerequisites: [],
    notes: "",
    schedulingMode: "one_off",
    intervalDays: "1",
    periodUnit: "interval",
    periodLength: "7",
    targetOccurrences: "1",
    minSpacingDays: "",
    eligibleWeekdays: [],
    recurrenceStart,
    recurrenceEnd,
    morningFallbackStart: "05:00",
    morningFallbackEnd: "08:00",
    bedtimeFallbackStart: "20:00",
    bedtimeFallbackEnd: "21:00",
    completionMode: "end_date",
    targetTotalMinutes: "",
    private: false
  };
};

export const areaDraftFrom = (item: StoredArea): AreaDraft => ({
  id: item.id,
  name: item.name,
  description: item.description ?? "",
  status: item.status,
  private: item.private ?? false
});

export const outcomeDraftFrom = (item: StoredOutcome, timezone: string): OutcomeDraft => ({
  id: item.id,
  areaId: item.areaId,
  title: item.title,
  definitionOfDone: item.definitionOfDone,
  value: item.value,
  status: item.status,
  deadlineAt: dateInput(item.deadlineAt, timezone),
  reviewOn: item.reviewOn ?? ""
});

export const projectDraftFrom = (item: StoredProject, timezone: string): ProjectDraft => ({
  id: item.id,
  outcomeId: item.outcomeId,
  title: item.title,
  status: item.status,
  uncertainty: item.uncertainty,
  internalDeadlineAt: dateInput(item.internalDeadlineAt, timezone),
  externalDeadlineAt: dateInput(item.externalDeadlineAt, timezone),
  consequence: item.consequence,
  remainingEffortOverrideMinutes: item.remainingEffortOverrideMinutes?.toString() ?? "",
  prerequisites: [...(item.prerequisites ?? [])],
  private: item.private ?? false
});

export function actionDraftFrom(item: StoredAction, timezone: string): ActionDraft {
  const morning = item.recurrence?.windows.find((window) => window.name === "Morning");
  const bedtime = item.recurrence?.windows.find((window) => window.name === "Bedtime");
  return {
    id: item.id,
    projectId: item.projectId,
    title: item.title,
    status: item.status,
    optimisticMinutes: item.optimisticMinutes,
    expectedMinutes: item.expectedMinutes,
    pessimisticMinutes: item.pessimisticMinutes,
    remainingMinutes: item.remainingMinutes,
    energy: item.energy,
    minimumSessionMinutes: item.minimumSessionMinutes,
    maximumSessionMinutes: item.maximumSessionMinutes,
    splittable: item.splittable,
    setupMinutes: item.setupMinutes,
    importance: item.importance,
    consequence: item.consequence,
    contexts: item.contexts.join(", "),
    pathways: item.requirementPathways?.length
      ? item.requirementPathways.map((pathway) => pathway.contextIds)
      : [item.contexts],
    preferences: item.preferences ?? [],
    availableFrom: dateInput(item.availableFrom, timezone),
    deadlineAt: dateInput(item.deadlineAt, timezone),
    latestStartAt: dateInput(item.latestStartAt, timezone),
    dependencyIds: item.dependencyIds,
    prerequisites: [...(item.prerequisites ?? [])],
    notes: item.notes ?? "",
    schedulingMode: item.schedulingMode ?? "one_off",
    intervalDays: item.recurrence?.intervalDays?.toString() ?? "1",
    periodUnit: item.recurrence?.period?.unit ?? "interval",
    periodLength: item.recurrence?.period?.unit === "days" ? item.recurrence.period.length.toString() : "7",
    targetOccurrences: item.recurrence?.targetOccurrences?.toString() ?? "1",
    minSpacingDays: item.recurrence?.minSpacingDays?.toString() ?? "",
    eligibleWeekdays: item.recurrence?.eligibleWeekdays ?? [],
    recurrenceStart: item.recurrence?.startDate,
    recurrenceEnd: item.recurrence?.endDate,
    morningFallbackStart: morning?.fallback?.startTime,
    morningFallbackEnd: morning?.fallback?.endTime,
    bedtimeFallbackStart: bedtime?.fallback?.startTime,
    bedtimeFallbackEnd: bedtime?.fallback?.endTime,
    completionMode: item.recurrence?.completionMode ?? (item.schedulingMode === "cadence" ? "manual" : "end_date"),
    targetTotalMinutes: item.recurrence?.targetTotalMinutes?.toString() ?? "",
    private: item.private ?? false
  };
}

/** The picker rides in an uncontrolled form as one JSON hidden input; anything unreadable is no prerequisites. */
function prerequisiteRefsFrom(value: FormDataEntryValue | null): PrerequisiteRef[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PrerequisiteRef =>
        typeof item === "object" &&
        item !== null &&
        ["project", "deliverable", "action"].includes((item as PrerequisiteRef).kind) &&
        typeof (item as PrerequisiteRef).id === "string" &&
        Boolean((item as PrerequisiteRef).id)
    );
  } catch {
    return [];
  }
}

export const deliverableDraftFrom = (form: FormData): DeliverableDraft => {
  const uncertainty = String(form.get("uncertainty") ?? "some");
  return {
    projectId: String(form.get("projectId") ?? ""),
    title: String(form.get("title") ?? "").trim(),
    externalDeadlineAt: String(form.get("externalDeadlineAt") ?? ""),
    internalDeadlineAt: String(form.get("internalDeadlineAt") ?? ""),
    uncertainty: uncertainty === "known" || uncertainty === "high" ? uncertainty : "some",
    dependencyIds: form
      .getAll("dependencyIds")
      .map((value) => String(value))
      .filter(Boolean),
    prerequisites: prerequisiteRefsFrom(form.get("prerequisites")),
    importance: Number(form.get("importance") ?? 3),
    consequence: Number(form.get("consequence") ?? 3),
    private: form.get("private") === "on"
  };
};

/** The planning metadata of a stored deliverable, in the form's own shape, so an edit starts from it. */
export const deliverableDraftFromStored = (item: StoredDeliverable, timezone: string): DeliverableDraft => ({
  projectId: item.projectId,
  title: item.title,
  externalDeadlineAt: dateInput(item.externalDeadlineAt, timezone),
  internalDeadlineAt: dateInput(item.internalDeadlineAt, timezone),
  uncertainty: item.uncertainty,
  dependencyIds: [...item.dependencyIds],
  prerequisites: [...(item.prerequisites ?? [])],
  importance: item.importance,
  consequence: item.consequence,
  private: item.private ?? false
});
