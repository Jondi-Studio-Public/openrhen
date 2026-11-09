import {
  buildDataFlowView,
  dataFlowRegistry,
  type DataFlowHealth,
  type DataFlowResponse
} from "@openrhen/contracts/data-flow";
import { log } from "@/server/logging";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { readHealth } from "./health-reader";
import { SCHEMA_TABLES } from "./schema-tables";

export type { DataFlowHealth, DataFlowResponse };

/** The body of `GET /api/data-flow`: the static graph plus what each node is doing now. Read-only. */

/** `never` is the count of sources not set up yet (no row, run or token), not a fault. */
const COUNTED = ["late", "stale", "failing", "never", "probe_unresolved"] as const;

export async function readDataFlow(sql: Sql, now: Date = new Date()): Promise<DataFlowResponse> {
  const registry = dataFlowRegistry();
  const view = buildDataFlowView(SCHEMA_TABLES, registry);
  let health: DataFlowHealth;
  const startedAt = Date.now();
  try {
    const read = await readHealth(sql, { now, entries: registry.entries });
    const counts: Record<string, number> = Object.fromEntries(COUNTED.map((state) => [state, 0]));
    for (const node of Object.values(read.nodes)) counts[node.freshness] = (counts[node.freshness] ?? 0) + 1;
    health = { ...read, counts };
  } catch (error) {
    // The driver's text can carry host and query detail, so it stays in the server log and the body is fixed.
    const code = (error as { code?: unknown } | null)?.code;
    log("error", "Data-flow health probes failed", {
      route: "/api/data-flow",
      method: "GET",
      status: 200,
      durationMs: Date.now() - startedAt,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      ...(typeof code === "string" ? { errorCode: code } : {})
    });
    health = {
      unavailable: true,
      reason: "The health probes could not be read.",
      next: "Run `rhen doctor`, then `rhen sources --problems`."
    };
  }
  const seen = new Map((health.unavailable ? [] : health.devices).map((device) => [device.id, device]));
  return {
    ...view,
    generatedAt: now.toISOString(),
    devices: view.devices.map((device) => {
      const live = seen.get(device.id);
      return live ? { ...device, lastSeenAt: live.lastSeenAt, lastSeenFrom: live.lastSeenFrom } : device;
    }),
    health
  };
}
