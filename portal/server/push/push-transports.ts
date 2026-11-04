import type { DoctorPublishingSlice } from "@openrhen/contracts";
import type { PoolSql, Sql } from "@/server/persistence/postgres/sql-pool";

/**
 * The `push_transport` registry. Web Push is core and is not registered here: `push-drain.ts` and the
 * `push_subscriptions` reads are called directly. Every other way of reaching a device (a native app) registers
 * itself from a drop-in folder (`server/drop-ins.ts`), so nothing in this repository's shared code names one.
 */
export interface PushTransport {
  /** Stable id. The drain route reports this transport's result under it, beside the Web Push result. */
  id: string;
  /**
   * This transport's half of `POST /api/integrations/push/drain`. Runs after the Web Push drain and must never
   * fail it: the route reports a throw under `id` instead of failing the request.
   */
  drain(sql: PoolSql, userId: string): Promise<unknown>;
  /** The data health check's view of this transport: devices whose latest delivery failed. Status only, no tokens. */
  failingDevices(sql: Sql, userId: string, limit: number): Promise<DoctorPublishingSlice["pushDevices"]>;
}

const transports = new Map<string, PushTransport>();

/** Registers a transport; a second registration under the same id replaces the first. */
export function registerPushTransport(transport: PushTransport): void {
  transports.set(transport.id, transport);
}

/** The registered transports, in registration order. */
export function pushTransports(): PushTransport[] {
  return [...transports.values()];
}

/** Removes a transport (tests). */
export function unregisterPushTransport(id: string): void {
  transports.delete(id);
}
