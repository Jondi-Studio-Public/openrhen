import { Table, getTableName, is } from "drizzle-orm";
import * as schema from "@openrhen/database/schema";
import { buildDataFlowView, dataFlowRegistry, type DataFlowView } from "@openrhen/contracts/data-flow";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { readHealth, type HealthResult } from "./health-reader";

/** The body of `GET /api/data-flow`: the static graph plus what each node is doing now. Read-only. */

const TABLES = Object.values(schema).flatMap((value) => (is(value, Table) ? [getTableName(value)] : []));

export type DataFlowHealth =
  (HealthResult & { unavailable?: undefined; counts: Record<string, number> }) | { unavailable: true; reason: string };

export interface DataFlowResponse extends Omit<DataFlowView, "devices"> {
  generatedAt: string;
  devices: (DataFlowView["devices"][number] & { lastSeenAt?: string | null; lastSeenFrom?: string | null })[];
  health: DataFlowHealth;
}

const COUNTED = ["late", "stale", "failing", "never", "probe_unresolved"] as const;

export async function readDataFlow(sql: Sql, now: Date = new Date()): Promise<DataFlowResponse> {
  const registry = dataFlowRegistry();
  const view = buildDataFlowView(TABLES, registry);
  let health: DataFlowHealth;
  try {
    const read = await readHealth(sql, { now, entries: registry.entries });
    const counts: Record<string, number> = Object.fromEntries(COUNTED.map((state) => [state, 0]));
    for (const node of Object.values(read.nodes))
      if (node.configured || node.freshness !== "never") counts[node.freshness] = (counts[node.freshness] ?? 0) + 1;
    health = { ...read, counts };
  } catch (error) {
    health = {
      unavailable: true,
      reason: error instanceof Error ? error.message.slice(0, 200) : "the health probes failed"
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
