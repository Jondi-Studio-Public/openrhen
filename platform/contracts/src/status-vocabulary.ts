/**
 * The status words an agent can save, one list per entity kind, with the synonyms each kind accepts.
 *
 * The kinds are the canonical names in the CLI's `save` entity types. Each `values` list is the
 * source zod enum's options, never a retyped copy, so a new status added to a schema shows up here
 * without an edit. A kind with no status field has no entry.
 *
 * A synonym only maps a word that is not a valid value for that kind onto one that is, and only
 * where the meaning is the same. Two values that are both valid for a kind are never mapped to
 * each other: a routine step's `skipped` and `cancelled` mean different things and stay apart.
 * Synonym keys are written with underscores; `normalizeStatus` treats "-" and spaces as "_".
 */
import { actionStatusSchema, lifecycleStatusSchema } from "./core.js";
import { conditionStatusSchema } from "./planning/context-model.js";
import {
  captureStatusSchema,
  commitmentStatusSchema,
  deliverableStatusSchema,
  routinePresetStatusSchema,
  routineStepStatusSchema,
  sleepPlanStatusSchema
} from "./portal/state-schema.js";

export interface StatusVocabularyEntry {
  readonly values: readonly string[];
  readonly synonyms: Readonly<Record<string, string>>;
}

const CANCELED = { canceled: "cancelled" } as const;
// "done" is the finished word for the kinds below, and "completed" for the ones after them.
const FINISHED_AS_DONE = { completed: "done", complete: "done", finished: "done" } as const;
const FINISHED_AS_COMPLETED = { done: "completed", complete: "completed", finished: "completed" } as const;

const LIFECYCLE: StatusVocabularyEntry = {
  values: lifecycleStatusSchema.options,
  synonyms: {
    ...FINISHED_AS_DONE,
    ...CANCELED,
    dropped: "cancelled",
    on_hold: "paused",
    hold: "paused",
    in_progress: "active",
    started: "active"
  }
};

export const STATUS_VOCABULARY: Readonly<Record<string, StatusVocabularyEntry>> = {
  area: LIFECYCLE,
  outcome: LIFECYCLE,
  project: LIFECYCLE,
  action: {
    values: actionStatusSchema.options,
    synonyms: {
      ...FINISHED_AS_DONE,
      ...CANCELED,
      dropped: "cancelled",
      todo: "planned",
      to_do: "planned",
      // An action being worked on is `doing`; `active` is a different, valid value.
      in_progress: "doing",
      started: "doing"
    }
  },
  commitment: { values: commitmentStatusSchema.options, synonyms: { ...CANCELED } },
  capture: {
    values: captureStatusSchema.options,
    // Dismissing a capture is what `ignored` records.
    synonyms: { dismissed: "ignored" }
  },
  deliverable: {
    values: deliverableStatusSchema.options,
    synonyms: { ...FINISHED_AS_COMPLETED, ...CANCELED, started: "in_progress" }
  },
  routine_step: {
    values: routineStepStatusSchema.options,
    synonyms: { ...FINISHED_AS_COMPLETED, ...CANCELED, in_progress: "doing", started: "doing" }
  },
  routine_preset: { values: routinePresetStatusSchema.options, synonyms: {} },
  sleep_plan: {
    values: sleepPlanStatusSchema.options,
    synonyms: { ...FINISHED_AS_COMPLETED, ...CANCELED }
  },
  condition_definition: { values: conditionStatusSchema.options, synonyms: {} }
};

export type NormalizedStatus = { ok: true; status: string; from?: string } | { ok: false; allowed: readonly string[] };

/**
 * Resolves the status word an agent typed for one entity kind. `from` is set only when a synonym was
 * mapped, carrying the trimmed, lower-cased word that was replaced. An unknown kind fails with no
 * allowed words.
 */
export function normalizeStatus(kind: string, raw: string): NormalizedStatus {
  const entry = STATUS_VOCABULARY[kind];
  if (!entry) return { ok: false, allowed: [] };
  const typed = raw.trim().toLowerCase();
  const word = typed.replace(/[-\s]+/g, "_");
  for (const candidate of [typed, word]) {
    if (entry.values.includes(candidate)) return { ok: true, status: candidate };
  }
  for (const candidate of [typed, word]) {
    const mapped = Object.hasOwn(entry.synonyms, candidate) ? entry.synonyms[candidate] : undefined;
    if (mapped !== undefined) return { ok: true, status: mapped, from: typed };
  }
  return { ok: false, allowed: entry.values };
}
