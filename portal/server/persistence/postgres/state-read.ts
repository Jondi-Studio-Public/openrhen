import { readPulseState } from "@/server/pulse/pulse-read";
import { occurrenceWindow } from "@/shared/history-window";
import type { PortalState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { readPrerequisiteMap } from "./prerequisites";
import { readActions } from "./readers/actions";
import { readAreas } from "./readers/areas";
import { readCaptures } from "./readers/captures";
import { readConditions } from "./readers/conditions";
import { readDailyPlan } from "./readers/daily-plan";
import { readDeliverables } from "./readers/deliverable-read";
import { readOccurrences } from "./readers/occurrences";
import { readOutcomes } from "./readers/outcomes";
import { readPlanningFocus } from "./readers/planning-focus";
import { readCurrentRecommendationId, readPlanning } from "./readers/planning-status";
import { readPreferences } from "./readers/preferences";
import { readProjects } from "./readers/projects";
import { readCommitmentsAndRoutines } from "./readers/routine-read";
import { readEstimateCalibration, readSessions } from "./readers/sessions";
import { readSpans } from "./readers/spans";
import type { Sql } from "./sql-pool";

export { readPlanningStatus } from "./readers/planning-status";

export interface ReadPortalStateOptions {
  /**
   * Set false to leave out the `planning` block: it carries the stored engine result (hundreds of KB of
   * JSONB to detoast and parse). Only a caller that builds a plan request from the state needs this; the
   * request schema has no `planning` field, so the request is identical. Defaults to true.
   */
  planning?: boolean;
}

/** The whole portal state document, hydrated from the normalised tables. */
export async function readPortalState(sql: Sql, options: ReadPortalStateOptions = {}): Promise<PortalState | null> {
  const userId = await ensureUser(sql);
  // Read first, not in document order: the timezone it carries is what the two bounded history reads
  // below measure their local day from.
  const preferences = await readPreferences(sql, userId);
  const timezone = preferences.timezone;
  const readAt = new Date();
  // `historyWindowStart`/`occurrenceWindow` live in the shared module now: `state-replace.ts` has to
  // scope its own delete to the same boundary, and `/review` and `/history` have to stop expecting
  // evidence past it, so one implementation has to serve the server read and both client consumers.
  const window = occurrenceWindow(readAt, timezone);
  const areas = await readAreas(sql, userId);
  const outcomes = await readOutcomes(sql, userId);
  const prerequisiteMap = await readPrerequisiteMap(sql, userId);
  const projects = await readProjects(sql, userId, prerequisiteMap);
  const actions = await readActions(sql, userId, prerequisiteMap);
  const occurrences = await readOccurrences(sql, userId, window);
  const conditionDefinitions = await readConditions(sql, userId);
  const deliverables = await readDeliverables(sql, userId);
  const routines = await readCommitmentsAndRoutines(sql, userId);
  const captures = await readCaptures(sql, userId);
  const sessions = await readSessions(sql, userId, window.from);
  const dailyPlan = await readDailyPlan(sql, userId, readAt);
  const estimateCalibration = await readEstimateCalibration(sql, userId);
  const planningFocus = await readPlanningFocus(sql, userId);
  const spans = await readSpans(sql, userId, readAt, timezone);
  const currentRecommendationId = await readCurrentRecommendationId(sql, userId);
  const pulse = await readPulseState(sql, userId, new Date(), timezone);
  const planning = options.planning === false ? undefined : await readPlanning(sql, userId);
  return {
    settings: preferences.settings,
    areas,
    outcomes,
    projects,
    actions,
    deliverables,
    occurrences,
    ...routines,
    captures,
    completedToday: sessions.completedToday,
    assertedConditions: preferences.assertedConditions,
    currentEnergy: preferences.currentEnergy,
    conditionDefinitions,
    currentSituation: preferences.currentSituation,
    pendingLocationSuggestion: preferences.pendingLocationSuggestion,
    horizonEnd: preferences.horizonEnd,
    activeSession: sessions.activeSession,
    ...(pulse ? { pulse } : {}),
    ...(dailyPlan ? { dailyPlan } : {}),
    planningFocus,
    spans,
    estimateCalibration,
    ...(currentRecommendationId ? { currentRecommendationId } : {}),
    ...(planning ? { planning } : {}),
    lastEndedSessions: sessions.lastEndedSessions
  };
}
