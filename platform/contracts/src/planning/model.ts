import type { ActionStatus, EnergyType, LifecycleStatus } from "../core.js";
import type { CommitmentRepeat } from "./commitment-repeat.js";
import type { TransportMode } from "./context-model.js";

export type PlanningEnergy = EnergyType;
export type PlanningActionStatus = ActionStatus;
export type PlanningOccurrenceStatus = "pending" | "completed" | "missed" | "cancelled";
export type PlanningOccurrenceAnchorSource =
  "actual_wake" | "planned_wake" | "preferred_wake" | "planned_sleep" | "local_time" | "fallback";

export interface PlanningRecurrenceWindow {
  id: string;
  name: string;
  anchor: "wake" | "sleep_start" | "local_time";
  startOffsetMinutes?: number;
  endOffsetMinutes?: number;
  localStartTime?: string;
  localEndTime?: string;
  fallback?: { startTime: string; endTime: string };
}

/** a rolling window of days ending today, or the calendar month containing today. */
export type PlanningCadencePeriod = { unit: "days"; length: number } | { unit: "month" };

export interface PlanningActionRecurrenceRule {
  id: string;
  actionId: string;
  timezone: string;
  startDate: string;
  endDate?: string;
  intervalDays: number;
  windows: PlanningRecurrenceWindow[];
  completionMode?: "end_date" | "total_minutes" | "manual";
  targetTotalMinutes?: number;
  accumulatedMinutes?: number;
  completedAt?: string;
  /** Cadence-only (`schedulingMode: "cadence"`); takes precedence over `intervalDays` when present. */
  period?: PlanningCadencePeriod;
  targetOccurrences?: number;
  minSpacingDays?: number;
  eligibleWeekdays?: number[];
}

export interface PlanningCommitmentRecurrenceRule {
  id: string;
  title: string;
  timezone: string;
  startDate: string;
  endDate?: string;
  repeat: CommitmentRepeat;
  localStartTime: string;
  localEndTime: string;
  location?: string;
  setupBeforeMinutes: number;
  transitionAfterMinutes: number;
  status: "active" | "ended";
  projectId?: string;
  /** Absent means true. Copied onto each occurrence at materialisation, part of the per-date overlay. */
  latenessMatters?: boolean;
  transportMode?: TransportMode;
  contactId?: string;
}

export interface PlanningProject {
  id: string;
  status: LifecycleStatus;
  uncertainty: "known" | "some" | "high";
  value: number;
  consequence: number;
  internalDeadlineAt?: Date;
  externalDeadlineAt?: Date;
  remainingEffortOverrideMinutes?: number;
  lastWorkedAt?: Date;
  /** When the person or an agent last confirmed the project is still wanted (the review's Keep). */
  lastReviewedAt?: Date;
  requiredCompletionRatio?: number;
  actualCompletionRatio?: number;
  outcomeActive?: boolean;
}

export interface PlanningAction {
  id: string;
  projectId: string;
  title: string;
  status: PlanningActionStatus;
  optimisticMinutes?: number;
  expectedMinutes: number;
  remainingMinutes: number;
  pessimisticMinutes: number;
  energy: PlanningEnergy;
  minimumSessionMinutes: number;
  maximumSessionMinutes: number;
  importance: number;
  consequence: number;
  availableFrom?: Date;
  deadlineAt?: Date;
  latestStartAt?: Date;
  contexts: string[];
  dependenciesComplete: boolean;
  dependencyIds?: string[];
  splittable?: boolean;
  setupMinutes?: number;
  lastWorkedAt?: Date;
  schedulingMode?: "one_off" | "recurring" | "cadence";
  occurrenceId?: string;
  occurrenceWindowName?: string;
  routineCovered?: boolean;
  templateActionId?: string;
  notes?: string;
}
