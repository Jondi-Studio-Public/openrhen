import {
  planReentrySettlement,
  REENTRY_ENERGIES,
  type CatchUpEntry,
  type CatchUpReentry,
  type ReentrySettlement
} from "@openrhen/contracts";
import { choicesFor, type CatchUpChoice } from "@/features/catch-up/catch-up-model";

export type ReentryEnergy = (typeof REENTRY_ENERGIES)[number];
export type ReentryTierName = CatchUpReentry["tier"];

/** What `GET /api/pulse/reentry` returns while the pulse is lapsed: the gap's review and the ids the facts can name. */
export interface ReentryReview {
  tier: ReentryTierName;
  lastConfirmedAt: string | null;
  gapMinutes: number | null;
  reviewable: number;
  lapsing: number;
  days: { day: string; entryIds: string[] }[];
  projects: { projectId: string | null; title: string | null; entryIds: string[] }[];
  entries: CatchUpEntry[];
}
export interface ReentryChoices {
  places: { id: string; name: string }[];
  contexts: { id: string; name: string; kind: string }[];
}

/** Everything the sheet holds before Submit. Nothing is answered until the person answers it. */
export interface ReentryDraft {
  locationId: string;
  energy: ReentryEnergy | "";
  /** Null until the person says (an empty list is the answer "none"). */
  contexts: string[] | null;
  /** Item by item: the only form that can write `done`. */
  items: Record<string, CatchUpChoice>;
  /** Tier days and up: a tapped day means "nothing recorded". */
  days: Record<string, true>;
  /** Tier projects. */
  projects: Record<string, "keep_open" | "drop_all">;
  startFresh: boolean;
  note: string;
}

export const EMPTY_REENTRY_DRAFT: ReentryDraft = {
  locationId: "",
  energy: "",
  contexts: null,
  items: {},
  days: {},
  projects: {},
  startFresh: false,
  note: ""
};

export const ENERGY_LABELS: Record<ReentryEnergy, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  recovery: "Recovery"
};

/** The answers an item offers when the sheet asks "what happened to it": the catch-up page's four, same words. */
export function itemChoices(entry: Pick<CatchUpEntry, "kind">): readonly CatchUpChoice[] {
  return choicesFor(entry.kind);
}

/** The wording of the gap, e.g. "about 5 hours" or "3 days". */
export function gapPhrase(gapMinutes: number | null): string {
  if (gapMinutes === null) return "a while";
  if (gapMinutes < 90) return `${Math.max(1, Math.round(gapMinutes))} minutes`;
  const hours = gapMinutes / 60;
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** The settlement the draft says, in the shape the command takes. Only forms with answers are included. */
export function buildSettlement(review: ReentryReview, draft: ReentryDraft): ReentrySettlement {
  const byId = new Map(review.entries.map((entry) => [entry.id, entry]));
  const items = Object.entries(draft.items).flatMap(([entryId, choice]) => {
    const entry = byId.get(entryId);
    if (!entry) return [];
    return [
      {
        entryId,
        verdict: choice,
        ...(entry.version !== null ? { version: entry.version } : {}),
        // A dropped deadline pauses its project, as on the catch-up page.
        ...(choice === "dropped" && entry.kind !== "occurrence" ? { becomes: "paused" as const } : {})
      }
    ];
  });
  const days = Object.keys(draft.days).map((day) => ({ day, answer: "nothing_recorded" as const }));
  const projects = Object.entries(draft.projects).map(([projectId, answer]) => ({ projectId, answer }));
  return {
    ...(items.length ? { items } : {}),
    ...(days.length && review.tier !== "today" && review.tier !== "none" ? { days } : {}),
    ...(projects.length && review.tier === "projects" ? { projects } : {}),
    ...(draft.startFresh && review.tier === "projects" ? { startFresh: true } : {})
  };
}

/**
 * The reviewable entries the draft leaves unanswered, by the same rule the server applies
 * (`planReentrySettlement`), so the button enables exactly when the server would accept.
 */
export function unreviewedEntries(review: ReentryReview, draft: ReentryDraft, timeZone: string): CatchUpEntry[] {
  const plan = planReentrySettlement(review.entries, review.tier, buildSettlement(review, draft), timeZone);
  const ids = new Set(plan.unreviewed.map((entry) => entry.id));
  return review.entries.filter((entry) => ids.has(entry.id));
}

/** The three facts the draft still lacks, by name. */
export function missingFacts(draft: ReentryDraft): ("location" | "energy" | "contexts")[] {
  const missing: ("location" | "energy" | "contexts")[] = [];
  if (!draft.locationId) missing.push("location");
  if (!draft.energy) missing.push("energy");
  if (draft.contexts === null) missing.push("contexts");
  return missing;
}

export interface ReentryProgress {
  facts: ("location" | "energy" | "contexts")[];
  unreviewed: number;
  complete: boolean;
}

export function reentryProgress(review: ReentryReview, draft: ReentryDraft, timeZone: string): ReentryProgress {
  const facts = missingFacts(draft);
  const unreviewed = unreviewedEntries(review, draft, timeZone).length;
  return { facts, unreviewed, complete: facts.length === 0 && unreviewed === 0 };
}

/** "Choose where you are, your energy and 3 items" for the line beside a disabled Submit. */
export function progressLine(progress: ReentryProgress): string {
  if (progress.complete) return "Ready.";
  const parts: string[] = [];
  if (progress.facts.length > 0) {
    const names = progress.facts.map((fact) =>
      fact === "contexts" ? "what's available" : fact === "location" ? "where you are" : "your energy"
    );
    parts.push(names.join(", "));
  }
  if (progress.unreviewed > 0)
    parts.push(`${progress.unreviewed} ${progress.unreviewed === 1 ? "item" : "items"} to review`);
  return `Still needed: ${parts.join(" and ")}.`;
}

/** The command body. `basis` is `stated`: it is the person's own tap on their own sheet. */
export function buildReenterBody(
  review: ReentryReview,
  draft: ReentryDraft,
  commandId: string
): Record<string, unknown> {
  const note = draft.note.trim();
  return {
    commandId,
    locationId: draft.locationId,
    energy: draft.energy,
    contexts: draft.contexts ?? [],
    settlement: buildSettlement(review, draft),
    basis: "stated",
    evidence: "Answered on the re-entry sheet",
    ...(note ? { note: note.slice(0, 2000) } : {})
  };
}

/** Day answer toggled on or off. */
export function toggleDay(draft: ReentryDraft, day: string): ReentryDraft {
  const { [day]: was, ...rest } = draft.days;
  return { ...draft, days: was ? rest : { ...rest, [day]: true } };
}

export function setItem(draft: ReentryDraft, entryId: string, choice: CatchUpChoice | null): ReentryDraft {
  const { [entryId]: _removed, ...rest } = draft.items;
  return { ...draft, items: choice === null ? rest : { ...rest, [entryId]: choice } };
}

export function setProject(
  draft: ReentryDraft,
  projectId: string,
  answer: "keep_open" | "drop_all" | null
): ReentryDraft {
  const { [projectId]: _removed, ...rest } = draft.projects;
  return { ...draft, projects: answer === null ? rest : { ...rest, [projectId]: answer } };
}

export function toggleContext(draft: ReentryDraft, id: string): ReentryDraft {
  const current = draft.contexts ?? [];
  return { ...draft, contexts: current.includes(id) ? current.filter((value) => value !== id) : [...current, id] };
}

/** Drops answers about entries the review no longer lists (settled elsewhere between two reads). */
export function pruneDraft(draft: ReentryDraft, review: ReentryReview): ReentryDraft {
  const ids = new Set(review.entries.map((entry) => entry.id));
  return { ...draft, items: Object.fromEntries(Object.entries(draft.items).filter(([id]) => ids.has(id))) };
}

/** The server's refusal body, when it is one: the sentence and each missing line. */
export function refusalFrom(body: unknown): { message: string; missing: string[] } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { code?: unknown; error?: unknown; missing?: unknown };
  if (record.code !== "reentryIncomplete" || typeof record.error !== "string") return null;
  return {
    message: record.error,
    missing: Array.isArray(record.missing)
      ? record.missing.filter((line): line is string => typeof line === "string")
      : []
  };
}
