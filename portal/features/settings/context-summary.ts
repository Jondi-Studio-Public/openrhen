import type { PortalState } from "@/state/portal-state";

export type ConditionDefinition = PortalState["conditionDefinitions"][number];
export type ConditionKind = ConditionDefinition["kind"];

export const conditionKinds = ["location", "capability", "contact", "live"] as const;

export const conditionKindLabels = {
  location: {
    title: "Locations",
    reason:
      "Places you can be. A location grants whatever is fixed there, so being at home is enough to say the desktop is available."
  },
  capability: {
    title: "Capabilities",
    reason:
      "Things you use. Fixed ones are inferred from where you are; portable ones travel with you and keep their own answer across a move."
  },
  contact: {
    title: "Contacts",
    reason:
      "People you need. A contact you can message or call is reachable anywhere; one you can only see in person depends on being where they are."
  },
  live: {
    title: "Live (while a commitment runs)",
    reason:
      'Something only true while it is actually happening. Satisfied only during a live, confirmed occurrence of the named recurring series or one-off — never its setup, travel, or transition buffers. For "only while the class is in session," not for anything that travels with you.'
  }
} as const;

/** The recurring series or one-off commitment a `live` condition names, for display. */
export function commitmentConditionTarget(
  entry: { recurrenceRuleId?: string | undefined; commitmentId?: string | undefined },
  rules: { id: string; title: string }[],
  commitments: { id: string; title: string }[]
): string {
  if (entry.recurrenceRuleId)
    return rules.find((rule) => rule.id === entry.recurrenceRuleId)?.title ?? "a deleted series";
  if (entry.commitmentId)
    return commitments.find((item) => item.id === entry.commitmentId)?.title ?? "a deleted commitment";
  return "nothing selected yet";
}

/** One line saying what this condition will actually do, rather than repeating its stored fields. */
export function describeCondition(entry: {
  kind: string;
  portability: string;
  grants: string[];
  channels: string[];
  pathways: string[][];
  travelMinutes?: number | undefined;
}) {
  if (entry.kind === "location")
    return `${entry.grants.length ? `grants ${entry.grants.join(", ")}` : "grants nothing"}${entry.travelMinutes === undefined ? "" : ` · ${entry.travelMinutes} min away`}`;
  if (entry.kind === "contact")
    return entry.channels.some((channel) => channel !== "in_person")
      ? "reachable anywhere"
      : entry.channels.length
        ? "in person only"
        : "no channel set, so always asks";
  if (entry.kind === "live") return "satisfied only while it is actually happening";
  if (entry.pathways.length)
    return `built from ${entry.pathways.length} route${entry.pathways.length === 1 ? "" : "s"}`;
  return entry.portability === "portable" ? "travels with you" : "belongs to a place";
}

/** One place something can happen at, reduced to what a picker beside a form needs. */
export interface PlaceOption {
  id: string;
  name: string;
  travelMinutes?: number | undefined;
}

/**
 * The places a picker may offer: every active location, plus whichever one the record already
 * points at, so a place archived after the fact stays visible instead of quietly reading as none.
 * One-off places — created quietly from a place search — are equally excluded unless already
 * chosen: they belong to the commitment that made them, not to the general catalogue.
 * Source order is kept, which is the order the Locations list itself shows.
 */
export function placeOptions(definitions: ConditionDefinition[], selectedId = ""): PlaceOption[] {
  return definitions
    .filter(
      (entry) => entry.kind === "location" && ((entry.status === "active" && !entry.oneOff) || entry.id === selectedId)
    )
    .map((entry) => ({ id: entry.id, name: entry.name, travelMinutes: entry.travelMinutes }));
}

/** The saved fallback figure for the chosen place, which is what travel costs until it is measured. */
export function placeTravelNote(options: PlaceOption[], selectedId: string): string {
  const minutes = options.find((option) => option.id === selectedId)?.travelMinutes;
  return minutes === undefined ? "" : `~${Math.round(minutes)} min from home`;
}

/**
 * Choosing a place also writes its name into the free-text label, but only while that label is
 * empty: the text is what a printed schedule shows, and someone who typed "Room 2.14" meant it.
 */
export function withPlace<T extends { location: string; locationId: string }>(
  draft: T,
  locationId: string,
  options: PlaceOption[]
): T {
  const name = options.find((option) => option.id === locationId)?.name ?? "";
  return { ...draft, locationId, location: locationId && !draft.location.trim() ? name : draft.location };
}

/**
 * Counts come from the pathways where an action has them and the legacy tags otherwise, so the
 * number means "actions that need this" throughout the migration rather than flipping when an
 * action moves across.
 */
export function conditionRequirementCounts(actions: PortalState["actions"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const used = action.requirementPathways?.length
      ? new Set(action.requirementPathways.flatMap((pathway) => pathway.contextIds))
      : new Set(action.contexts);
    for (const context of used) counts.set(context, (counts.get(context) ?? 0) + 1);
  }
  return counts;
}

/**
 * The picker vocabulary for every place that used to offer the flat context catalogue (the
 * import review screen, the routine step editor) — every active typed condition's id, since typed
 * definitions are the authoritative source now.
 */
export function activeConditionIds(definitions: ConditionDefinition[]): string[] {
  return definitions.filter((entry) => entry.status === "active").map((entry) => entry.id);
}

/**
 * Matching the id as well as the name matters: requirements, grants and the import flow all refer
 * to a condition by its id, so that is often what someone has in hand when they come looking.
 */
export function matchConditionDefinitions(group: ConditionDefinition[], filter: string): ConditionDefinition[] {
  const term = filter.trim().toLocaleLowerCase();
  if (!term) return group;
  return group.filter((entry) => entry.name.toLocaleLowerCase().includes(term) || entry.id.includes(term));
}
