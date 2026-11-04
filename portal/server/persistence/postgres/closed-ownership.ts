import type { CLOSED_TABLES } from "@openrhen/contracts";

/**
 * How each closable table is owned by a user: a SQL condition over the table aliased `t`, with the user id as `$1`.
 * Shared by the data health check (`doctor-closed.ts`) and the Closed page read (`readers/closed.ts`), so the two
 * can never disagree about whose rows they count.
 */
export const OWNED_BY_USER: Record<keyof typeof CLOSED_TABLES, string> = {
  areas: "t.user_id = $1",
  outcomes: "EXISTS (SELECT 1 FROM areas a WHERE a.id = t.area_id AND a.user_id = $1)",
  projects:
    "EXISTS (SELECT 1 FROM outcomes o JOIN areas a ON a.id = o.area_id WHERE o.id = t.outcome_id AND a.user_id = $1)",
  actions:
    "EXISTS (SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = t.project_id AND a.user_id = $1)",
  deliverables:
    "EXISTS (SELECT 1 FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE p.id = t.project_id AND a.user_id = $1)",
  commitments: "t.user_id = $1",
  routine_presets: "t.user_id = $1",
  condition_definitions: "t.user_id = $1"
};
