import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * The lease owner this process writes into `jobs.locked_by`. A pid alone is not unique: two containers
 * both run node as PID 1, so their ids collided and an expired worker could finish the replacement's
 * claim. The host name separates machines and containers; the random suffix separates restarts of the
 * same container, so a dead claim is never mistaken for the new process's own.
 */
export function createWorkerId(pid = process.pid, host = hostname(), suffix = randomUUID().slice(0, 8)): string {
  return `plan-forecast-worker-${host}-${pid}-${suffix}`;
}
