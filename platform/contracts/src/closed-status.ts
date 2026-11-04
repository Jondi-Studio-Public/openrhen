/**
 * The one definition of "closed" (docs: archive-removals design, section 1). A record is closed when its status is
 * `archived` or `cancelled`; `done` and `completed` are finished, not closed. A copy that means "finished" is
 * `isDoneStatus(x) || isClosedStatus(x)`, never a literal list.
 */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(["archived", "cancelled"]);

export function isClosedStatus(status: string | null | undefined): boolean {
  return status != null && CLOSED_STATUSES.has(status);
}

/** What a record's tables count as closed, and where a restore lands when `closed_from_status` is unknown. */
export interface ClosedTableRule {
  readonly closed: readonly string[];
  readonly restoreDefault: string;
}

export const CLOSED_TABLES = {
  areas: { closed: ["archived", "cancelled"], restoreDefault: "active" },
  outcomes: { closed: ["archived", "cancelled"], restoreDefault: "active" },
  projects: { closed: ["archived", "cancelled"], restoreDefault: "active" },
  actions: { closed: ["archived", "cancelled"], restoreDefault: "planned" },
  deliverables: { closed: ["archived", "cancelled"], restoreDefault: "ready" },
  commitments: { closed: ["cancelled"], restoreDefault: "confirmed" },
  routine_presets: { closed: ["archived"], restoreDefault: "active" },
  condition_definitions: { closed: ["archived"], restoreDefault: "active" }
} as const satisfies Record<string, ClosedTableRule>;

export type ClosedTable = keyof typeof CLOSED_TABLES;

/**
 * The status that takes a record out of the plan without deleting it, per entity type (the CLI's `save` sets the
 * same ones to hide a record it created; the agent hard floor names them as the alternative to a removal). A capture
 * is hidden by being ignored.
 */
export const HIDING_STATUS: Readonly<Record<string, string>> = {
  area: "archived",
  outcome: "cancelled",
  project: "cancelled",
  action: "cancelled",
  commitment: "cancelled",
  capture: "ignored",
  routine_preset: "archived",
  condition_definition: "archived"
};
