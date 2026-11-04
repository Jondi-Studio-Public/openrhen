import {
  CLOSED_TABLES,
  CLOSE_TABLE_OF,
  formatAgentCall,
  restoreCall,
  type AgentCall,
  type CloseType
} from "@openrhen/contracts";

/** The close type each list entity holds (`rhen_list`'s kind names), for the eight that can be closed. */
const TYPE_OF_ENTITY: Readonly<Record<string, CloseType>> = {
  areas: "area",
  outcomes: "outcome",
  projects: "project",
  actions: "action",
  deliverables: "deliverable",
  commitments: "commitment",
  "routine-presets": "routine_preset",
  conditions: "condition_definition"
};

/**
 * The restore call a closed row carries (`rhen_list`, `rhen_show`), or undefined for a row that is open,
 * of a kind that cannot be closed, or has no version to restore against (then `rhen_show` has the version).
 */
export function restoreCallOf(entityName: string, row: Record<string, unknown>): AgentCall | undefined {
  const type = TYPE_OF_ENTITY[entityName];
  if (type === undefined) return undefined;
  const status = row.status;
  const closed: readonly string[] = CLOSED_TABLES[CLOSE_TABLE_OF[type]].closed;
  if (typeof status !== "string" || !closed.includes(status)) return undefined;
  if (typeof row.id !== "string" || typeof row.version !== "number") return undefined;
  return restoreCall(type, row.id, row.version, status);
}

/** The restore call as the surface shows it: a tool call for an MCP agent, the shell command for a person. */
export function restoreCallText(call: AgentCall, mcp: boolean): string {
  if (mcp) return formatAgentCall(call);
  const args = call.arguments as { type: string; id: string };
  return `rhen ${call.tool === "rhen_cancel" ? "cancel" : "archive"} ${args.type} ${args.id} --restore`;
}
