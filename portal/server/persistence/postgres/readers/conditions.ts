import { conditionDefinitions } from "@openrhen/database";
import type { PortalState } from "@/state/portal-state";
import type { Row } from "../db-row";
import type { Sql } from "../sql-pool";

export async function readConditions(sql: Sql, userId: string): Promise<PortalState["conditionDefinitions"]> {
  const conditionDefinitionRows = await sql<
    (Row<
      typeof conditionDefinitions,
      | "id"
      | "name"
      | "status"
      | "kind"
      | "portability"
      | "pathways"
      | "grants"
      | "channels"
      | "travel_minutes"
      | "latitude"
      | "longitude"
      | "address"
      | "setup_before_minutes"
      | "transition_after_minutes"
      | "default_routine_preset_id"
      | "one_off"
      | "recurrence_rule_id"
      | "commitment_id"
      | "version"
      | "usual_transport_mode"
      | "phone"
      | "email"
    > & {
      status: PortalState["conditionDefinitions"][number]["status"];
      usual_transport_mode: PortalState["conditionDefinitions"][number]["usualTransportMode"] | null;
    })[]
  >`
      SELECT id, name, kind, status, portability, pathways, grants, channels, travel_minutes, latitude, longitude, address, setup_before_minutes, transition_after_minutes, default_routine_preset_id, one_off, recurrence_rule_id, commitment_id, version, usual_transport_mode, phone, email
      FROM condition_definitions WHERE user_id = ${userId} ORDER BY name, id
    `;
  return conditionDefinitionRows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    portability: row.portability,
    version: row.version,
    pathways: Array.isArray(row.pathways) ? (row.pathways as string[][]) : [],
    grants: Array.isArray(row.grants) ? row.grants.filter((value): value is string => typeof value === "string") : [],
    channels: Array.isArray(row.channels)
      ? (row.channels as PortalState["conditionDefinitions"][number]["channels"])
      : [],
    ...(row.travel_minutes !== null ? { travelMinutes: row.travel_minutes } : {}),
    ...(row.latitude !== null ? { latitude: row.latitude } : {}),
    ...(row.longitude !== null ? { longitude: row.longitude } : {}),
    ...(row.address ? { address: row.address } : {}),
    setupBeforeMinutes: row.setup_before_minutes,
    transitionAfterMinutes: row.transition_after_minutes,
    ...(row.default_routine_preset_id ? { defaultRoutinePresetId: row.default_routine_preset_id } : {}),
    ...(row.one_off ? { oneOff: true } : {}),
    ...(row.recurrence_rule_id ? { recurrenceRuleId: row.recurrence_rule_id } : {}),
    ...(row.commitment_id ? { commitmentId: row.commitment_id } : {}),
    ...(row.usual_transport_mode ? { usualTransportMode: row.usual_transport_mode } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.email ? { email: row.email } : {})
  }));
}
