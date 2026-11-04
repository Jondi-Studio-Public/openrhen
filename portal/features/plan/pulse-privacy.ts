import type { StoredArea, StoredOutcome, StoredProject } from "@/state/portal-state";

/**
 * The pulse criteria and publish design note, Decision "Private" (P3): effective privacy is
 * OR-inherited down area → (outcome) → project → action/deliverable/commitment. Outcomes carry no
 * flag of their own — they inherit their area's and pass it on. These helpers only compute what an
 * editor *shows* ("Private through <name>", not editable downward); the effective privacy the judge
 * and the publisher actually use is resolved server-side (`pulse-recorder.ts`'s own
 * `resolveEffectivePrivacy`), independently of what any one editor happens to display.
 */

/** The area a project's outcome belongs to, or undefined if either link does not resolve. */
export function areaOfOutcome(
  outcomeId: string,
  outcomes: StoredOutcome[],
  areas: StoredArea[]
): StoredArea | undefined {
  const outcome = outcomes.find((item) => item.id === outcomeId);
  return outcome ? areas.find((item) => item.id === outcome.areaId) : undefined;
}

/** The nearest private ancestor's display name for a project (its area only — a project has no
    closer ancestor of its own), or null when nothing above it is private. */
export function projectInheritedPrivacyFrom(
  outcomeId: string,
  outcomes: StoredOutcome[],
  areas: StoredArea[]
): string | null {
  const area = areaOfOutcome(outcomeId, outcomes, areas);
  return area?.private ? area.name : null;
}

/** The nearest private ancestor's display name for something under a project (an action, a
    deliverable, a commitment): the project itself first, then its area. */
export function belowProjectInheritedPrivacyFrom(
  projectId: string,
  projects: StoredProject[],
  outcomes: StoredOutcome[],
  areas: StoredArea[]
): string | null {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return null;
  if (project.private) return project.title;
  return projectInheritedPrivacyFrom(project.outcomeId, outcomes, areas);
}
