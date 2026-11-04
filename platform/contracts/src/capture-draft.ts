/**
 * The pure parts of reviewing a capture, shared by the portal's editor (`portal/features/capture`) and
 * the CLI's `inbox-act captured confirm`, so the two cannot drift: the draft a capture opens with and
 * the rule that decides whether a draft may be confirmed. Each caller words the refusal for its own
 * audience (the editor says "Choose an area", the CLI says `--set areaId=...`) from the shared code.
 */

export type CaptureDraftEnergy = "high" | "medium" | "low" | "recovery";

/** The fields every review draft carries; the portal's `ProposalDraft` adds the proposal type and notes. */
export interface CaptureDraftFields {
  title: string;
  notes: string;
  areaId: string;
  outcomeId: string;
  projectId: string;
  definitionOfDone: string;
  value: number;
  internalDeadlineAt: string;
  externalDeadlineAt: string;
  expectedMinutes: number;
  pessimisticMinutes: number;
  energy: CaptureDraftEnergy;
  startsAt: string;
  endsAt: string;
  location: string;
  locationId: string;
}

const ENERGIES: readonly string[] = ["high", "medium", "low", "recovery"];

/**
 * What a draft opens with for a capture: whatever an earlier review or an AI proposal saved in
 * `proposedFields`, otherwise the capture's own text as the title and the editor's defaults. `date`
 * shapes each saved date (the editor cuts to the minute for a `datetime-local` input; the CLI keeps
 * the stored instant).
 */
export function captureDraftFromSaved(
  saved: Record<string, unknown>,
  captureText: string,
  date: (value: string) => string = (value) => value
): CaptureDraftFields {
  const str = (key: string) => (typeof saved[key] === "string" ? (saved[key] as string) : "");
  const dateOf = (key: string) => (typeof saved[key] === "string" ? date(saved[key] as string) : "");
  const num = (key: string, fallback: number) => (typeof saved[key] === "number" ? (saved[key] as number) : fallback);
  return {
    title: typeof saved.title === "string" ? saved.title : captureText,
    notes: str("notes"),
    areaId: str("areaId"),
    outcomeId: str("outcomeId"),
    projectId: str("projectId"),
    definitionOfDone: str("definitionOfDone"),
    value: num("value", 3),
    internalDeadlineAt: dateOf("internalDeadlineAt"),
    externalDeadlineAt: dateOf("externalDeadlineAt"),
    expectedMinutes: num("expectedMinutes", 30),
    pessimisticMinutes: num("pessimisticMinutes", 45),
    energy: ENERGIES.includes(str("energy")) ? (str("energy") as CaptureDraftEnergy) : "medium",
    startsAt: dateOf("startsAt"),
    endsAt: dateOf("endsAt"),
    location: str("location"),
    locationId: str("locationId")
  };
}

/** Why a draft cannot be confirmed yet, in the order the checks run. */
export type CaptureDraftIssue =
  | "unclassified"
  | "title_missing"
  | "value_out_of_range"
  | "outcome_needs_area_and_done"
  | "project_needs_outcome"
  | "action_needs_project"
  | "deliverable_needs_project"
  | "commitment_needs_times"
  | "commitment_ends_before_start"
  | "internal_after_external"
  | "action_estimates_invalid"
  | "area_missing"
  | "outcome_missing"
  | "project_missing";

/** The records a draft may be placed under. */
export interface CaptureDraftLookup {
  areas?: readonly { id: string }[];
  outcomes?: readonly { id: string }[];
  projects?: readonly { id: string }[];
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** The first reason the draft may not be confirmed, or null when it may. */
export function captureDraftIssue(
  lookup: CaptureDraftLookup,
  draft: Record<string, unknown>
): CaptureDraftIssue | null {
  const type = draft.proposalType;
  const value = draft.value as number;
  if (type === "unclassified") return "unclassified";
  if (!asText(draft.title).trim()) return "title_missing";
  if (!Number.isFinite(value) || value < 1 || value > 5) return "value_out_of_range";
  if (type === "outcome" && (!asText(draft.areaId) || !asText(draft.definitionOfDone).trim()))
    return "outcome_needs_area_and_done";
  if (type === "project" && !asText(draft.outcomeId)) return "project_needs_outcome";
  if (type === "action" && !asText(draft.projectId)) return "action_needs_project";
  if (type === "deliverable" && !asText(draft.projectId)) return "deliverable_needs_project";
  if (type === "fixed_commitment") {
    if (!asText(draft.startsAt) || !asText(draft.endsAt)) return "commitment_needs_times";
    if (new Date(asText(draft.startsAt)) >= new Date(asText(draft.endsAt))) return "commitment_ends_before_start";
  }
  const internal = asText(draft.internalDeadlineAt);
  const external = asText(draft.externalDeadlineAt);
  if (internal && external && new Date(internal) > new Date(external)) return "internal_after_external";
  if (type === "action") {
    const expected = draft.expectedMinutes as number;
    const pessimistic = draft.pessimisticMinutes as number;
    if (!Number.isFinite(expected) || !Number.isFinite(pessimistic) || expected < 1 || pessimistic < expected)
      return "action_estimates_invalid";
  }
  if (asText(draft.areaId) && !(lookup.areas ?? []).some((area) => area.id === draft.areaId)) return "area_missing";
  if (asText(draft.outcomeId) && !(lookup.outcomes ?? []).some((outcome) => outcome.id === draft.outcomeId))
    return "outcome_missing";
  if (asText(draft.projectId) && !(lookup.projects ?? []).some((project) => project.id === draft.projectId))
    return "project_missing";
  return null;
}
