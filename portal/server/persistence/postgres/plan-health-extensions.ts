import type { HealthSnapshot } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * Registry of the mail a feature the OpenRhen export leaves out adds to the plan health snapshot: the
 * emails the checks compare against the plan. `private/index.ts` registers each on import; the export excludes that
 * folder and ships an empty `private/index.ts`, so the snapshot has no emails and those checks find nothing.
 */
export interface PlanHealthEmailSource {
  id: string;
  /** Emails received on or after `since`. */
  read(sql: Sql, since: Date): Promise<HealthSnapshot["emails"]>;
}

const sources: PlanHealthEmailSource[] = [];

export function registerPlanHealthEmailSource(source: PlanHealthEmailSource): void {
  if (!sources.some((existing) => existing.id === source.id)) sources.push(source);
}

export async function readPlanHealthEmails(sql: Sql, since: Date): Promise<HealthSnapshot["emails"]> {
  return (await Promise.all(sources.map((source) => source.read(sql, since)))).flat();
}
