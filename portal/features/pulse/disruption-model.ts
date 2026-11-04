import { localInputToInstant } from "@/features/catch-up/catch-up-model";
import { DISRUPTION_MAX_MINUTES, type DisruptionField } from "@openrhen/contracts";

/** The lengths the form offers; "custom" takes a date and time. */
export const UNTIL_PRESETS = [
  { id: "30", minutes: 30, label: "30 min" },
  { id: "60", minutes: 60, label: "1 hour" },
  { id: "120", minutes: 120, label: "2 hours" },
  { id: "180", minutes: 180, label: "3 hours" }
] as const;

export interface DisruptionDraft {
  /** What he is doing instead, in words. Optional when a planned task is named. */
  doing: string;
  /** A planned action he is doing instead, else "". */
  targetId: string;
  /** A preset's id, "custom", or "" (not chosen). */
  untilChoice: string;
  /** Custom only: local `YYYY-MM-DDTHH:mm`. */
  untilCustom: string;
  locationId: string;
  contexts: string[];
  /** Null until answered: yes, it takes all of him; no, he could still do other things. */
  exclusive: boolean | null;
}

export const EMPTY_DISRUPTION_DRAFT: DisruptionDraft = {
  doing: "",
  targetId: "",
  untilChoice: "",
  untilCustom: "",
  locationId: "",
  contexts: [],
  exclusive: null
};

export const FIELD_LABELS: Record<DisruptionField, string> = {
  doing: "what you are doing",
  until: "until when",
  locationId: "where you are",
  contexts: "what you have available (at least one)",
  exclusive: "whether it takes all of you"
};

/** The instant the draft's "until" stands for, or null while it is unchosen or unreadable. Custom times are read in the planning timezone, not the browser's. */
export function untilInstant(draft: DisruptionDraft, now: Date, timezone: string): Date | null {
  if (draft.untilChoice === "custom") {
    if (!draft.untilCustom) return null;
    const at = new Date(localInputToInstant(draft.untilCustom, timezone));
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const preset = UNTIL_PRESETS.find((entry) => entry.id === draft.untilChoice);
  return preset ? new Date(now.getTime() + preset.minutes * 60_000) : null;
}

/** The fields the draft lacks, named as the server names them, plus an "until" that is not in the future or is too far off. */
export function missingDisruption(draft: DisruptionDraft, now: Date, timezone: string): DisruptionField[] {
  const missing: DisruptionField[] = [];
  const until = untilInstant(draft, now, timezone);
  if (draft.doing.trim() === "" && !draft.targetId) missing.push("doing");
  if (!until || until.getTime() <= now.getTime() || until.getTime() - now.getTime() > DISRUPTION_MAX_MINUTES * 60_000)
    missing.push("until");
  if (!draft.locationId) missing.push("locationId");
  if (draft.contexts.length === 0) missing.push("contexts");
  if (draft.exclusive === null) missing.push("exclusive");
  return missing;
}

/** The command body for a complete draft (call `missingDisruption` first). A named task wins over the words. */
export function buildDisruptionBody(
  draft: DisruptionDraft,
  now: Date,
  timezone: string,
  commandId: string,
  targetTitle?: string
): Record<string, unknown> {
  const until = untilInstant(draft, now, timezone);
  return {
    commandId,
    doing: draft.targetId
      ? {
          kind: "action",
          id: draft.targetId,
          title: (draft.doing.trim() || targetTitle || "").slice(0, 300) || undefined
        }
      : draft.doing.trim(),
    until: until?.toISOString(),
    locationId: draft.locationId,
    contexts: draft.contexts,
    exclusive: draft.exclusive,
    basis: "stated",
    evidence: "Answered on the disruption form"
  };
}

export function toggleDisruptionContext(draft: DisruptionDraft, id: string): DisruptionDraft {
  return {
    ...draft,
    contexts: draft.contexts.includes(id) ? draft.contexts.filter((value) => value !== id) : [...draft.contexts, id]
  };
}

/** One sentence naming what is missing, for beside a refused Save. */
export function missingSentence(fields: readonly DisruptionField[]): string {
  return `Still needed: ${fields.map((field) => FIELD_LABELS[field]).join(", ")}.`;
}
